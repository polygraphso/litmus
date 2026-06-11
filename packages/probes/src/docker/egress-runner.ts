/**
 * C-02 / probe 4.2 egress sandbox (technical-design §4).
 *
 * Approach — default-deny + capture. Run the target npm MCP in a hardened
 * container attached to an `--internal` Docker network (no route to the
 * internet) whose DNS + catch-all point at a local **sinkhole** that logs
 * `{host, port, firstBytes}` and never completes a connection. Exercise the
 * tools (which should need no network), then read the sinkhole log: any logged
 * attempt is a C-02 finding; canary bytes in an attempt are a 4.2 finding.
 *
 * Fallback ladder (degrade, never crash): sinkhole → (future) `--network none`
 * → skip. Any failure in the Docker path returns `ran: false` with a reason, so
 * the grade degrades to B rather than erroring.
 *
 * NOTE: the Docker happy-path requires a Docker-equipped machine and is verified
 * there (see plans/external-needs.md). The pure log parser and the skip path are
 * unit-tested here.
 */

import { randomUUID } from "node:crypto";
import { parseServerRef } from "@polygraph/core";
import type { Finding } from "@polygraph/core";
import { connectTarget } from "../connect/index.js";
import { exerciseTool } from "../probes/exercise.js";
import { canaryMatch } from "../probes/scanners.js";
import { docker, ensureImage, labelFlags, stageNpmPackage } from "./staging.js";

const IMAGE_TAG = "polygraph-egress-sniff:latest";

export interface EgressAttempt {
  kind: "tcp" | "dns";
  host?: string;
  port?: number;
  firstBytes?: string;
}

export interface EgressResult {
  /** Whether the sandbox actually ran (false → C-02 skipped, 4.2 partial). */
  ran: boolean;
  reason: string | null;
  attempts: EgressAttempt[];
}

function notRan(reason: string): EgressResult {
  return { ran: false, reason, attempts: [] };
}

/** Parse the sinkhole's `EGRESS {json}` lines into structured attempts. Pure. */
export function parseSinkholeOutput(output: string): EgressAttempt[] {
  const attempts: EgressAttempt[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^EGRESS\s+(\{.*\})\s*$/);
    if (!m) continue;
    try {
      const rec = JSON.parse(m[1]!) as Partial<EgressAttempt> & { kind?: string };
      if (rec.kind === "tcp" || rec.kind === "dns") {
        attempts.push({
          kind: rec.kind,
          ...(rec.host !== undefined ? { host: rec.host } : {}),
          ...(rec.port !== undefined ? { port: rec.port } : {}),
          ...(rec.firstBytes !== undefined ? { firstBytes: rec.firstBytes } : {}),
        });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return attempts;
}

/** Map egress attempts to C-02 findings (any attempt is a finding). */
export function egressToFindings(attempts: readonly EgressAttempt[]): Finding[] {
  return attempts.map((a) => ({
    kind: "egress",
    severity: "high",
    match: a.host ? `${a.host}${a.port ? `:${a.port}` : ""}` : `port ${a.port ?? "?"}`,
    ...(a.host !== undefined ? { host: a.host } : {}),
    ...(a.port !== undefined ? { port: a.port } : {}),
    ...(a.firstBytes !== undefined ? { firstBytes: a.firstBytes } : {}),
  }));
}

/** Scan captured egress payloads for planted canaries (probe 4.2). */
export function egressCanaryFindings(attempts: readonly EgressAttempt[], canaries: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const a of attempts) {
    // TCP payload bytes...
    if (a.firstBytes) findings.push(...canaryMatch(a.firstBytes, canaries));
    // ...and the DNS query name: a canary smuggled into sub-domain labels
    // (`<canary>.attacker.tld`) is exfiltration just like a TCP body.
    if (a.host) findings.push(...canaryMatch(a.host, canaries));
  }
  return findings;
}

export interface EgressProbeOptions {
  /** Canary env to seed into the target container (so 4.2 can catch exfil). */
  canaryEnv: Record<string, string>;
  /**
   * When set, every docker resource created by this run (staging volume, sink,
   * `--internal` network, target container) carries
   * `--label polygraph-litmus-run=<runLabel>`, so a SIGKILLed parent can sweep
   * everything by label.
   */
  runLabel?: string;
}

export interface EgressTargetArgsOptions {
  targetName: string;
  net: string;
  sinkIp: string;
  vol: string;
  entry: string;
  canaryEnv: Record<string, string>;
  label: string[];
  /** Docker runtime override (production: `runsc`/gVisor). Same env as the main-connect container. */
  runtime?: string;
}

/**
 * Build the `docker run -i …` args for the C-02 egress *target* container. Pure,
 * so the hardening flag set — and the gVisor runtime passthrough — is unit-testable.
 * The target runs the SAME untrusted package as the main-connect path, so it MUST
 * carry the same `--runtime` override when one is configured (runtime parity).
 */
export function egressTargetArgs(opts: EgressTargetArgsOptions): string[] {
  const envFlags = Object.entries(opts.canaryEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const runtimeFlags = opts.runtime ? ["--runtime", opts.runtime] : [];
  return [
    "run", "-i", "--rm", "--name", opts.targetName, "--network", opts.net, "--dns", opts.sinkIp, "-v", `${opts.vol}:/stage:ro`,
    "--user", "node", "--read-only", "--tmpfs", "/tmp:rw,mode=1777", "--cap-drop=ALL",
    // Disable IPv6 in the target: the sinkhole/iptables capture is IPv4-only, so
    // an IPv6 socket would otherwise dodge detection (and, on a dual-stack net,
    // egress). --cpus bounds host CPU starvation by a hostile busy-loop.
    "--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--sysctl", "net.ipv6.conf.default.disable_ipv6=1",
    "--cpus", "1", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "512m",
    ...opts.label, ...envFlags, ...runtimeFlags,
    "--entrypoint", "node", IMAGE_TAG, opts.entry,
  ];
}

/**
 * Run the target npm MCP under the egress sandbox and return what it tried to
 * reach. Best-effort: any Docker error degrades to `ran: false`.
 */
export async function runEgressProbe(ref: string, opts: EgressProbeOptions): Promise<EgressResult> {
  let parsed;
  try {
    parsed = parseServerRef(ref);
  } catch {
    return notRan("egress sandbox only runs launchable package refs (npm)");
  }
  if (parsed.registry !== "npm") {
    return notRan(`egress sandbox for ${parsed.registry} targets not implemented (npm only)`);
  }
  const pkgSpec =
    (parsed.owner ? `${parsed.owner}/${parsed.name}` : parsed.name) + (parsed.version ? `@${parsed.version}` : "");

  const net = `pg-egress-${randomUUID().slice(0, 8)}`;
  const sink = `pg-sink-${randomUUID().slice(0, 8)}`;
  // The target runs over `docker run -i`; a node server does NOT exit when its
  // stdin closes, so `--rm` never fires on `client.close()` alone. Name it so the
  // finally can force-remove it (which also frees the --internal network).
  const targetName = `pg-target-${randomUUID().slice(0, 8)}`;
  const label = labelFlags(opts.runLabel);

  // Stage own volume per probe run — no sharing with other paths (plan decision).
  let staged: Awaited<ReturnType<typeof stageNpmPackage>> | null = null;
  try {
    // Build the hardened image, then install the target + its full dependency tree
    // into a labeled volume so the sandboxed run needs no internet. Egress detection
    // only means something once the package is staged offline — otherwise the package
    // fetch is itself the (expected) egress and the server never even starts.
    await ensureImage();
    try {
      staged = await stageNpmPackage(pkgSpec, opts.runLabel ? { runLabel: opts.runLabel } : {});
    } catch (err) {
      // No bin under sandbox policy: surface the specific reason verbatim. Any other
      // staging error is a docker fault → let the outer catch label it "unavailable".
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("exposes no launchable bin")) return notRan(msg);
      throw err;
    }
    const { volume: vol, entry } = staged;

    // Sinkhole on an --internal network (no route out; DNS + catch-all → sink).
    await docker(["network", "create", "--internal", ...label, net]);
    // The sink is the one TRUSTED, root component (needs NET_ADMIN + iptables +
    // privileged port 53), isolated on the --internal net; still resource-bounded.
    await docker([
      "run", "-d", "--name", sink, "--network", net, ...label,
      "--cap-add=NET_ADMIN", "--pids-limit", "64", "--memory", "256m",
      "--entrypoint", "/sink-entrypoint.sh", IMAGE_TAG,
    ]);
    const sinkIp = (await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, sink])).trim();

    // Target: NON-ROOT (node uid 1000, shipped by node:22-slim), caps dropped,
    // read-only rootfs, DNS → sinkhole, no internet; runs the staged install OFFLINE
    // so any outbound is the server's own (a C-02 finding). /tmp is the only writable
    // path (mode 1777 so the non-root user can use it). It runs the SAME untrusted
    // package as the main-connect path, so it carries the same gVisor `--runtime`
    // override when one is configured (LITMUS_DOCKER_RUNTIME) — runtime parity.
    const targetArgs = egressTargetArgs({
      targetName, net, sinkIp, vol, entry, canaryEnv: opts.canaryEnv, label,
      ...(process.env.LITMUS_DOCKER_RUNTIME ? { runtime: process.env.LITMUS_DOCKER_RUNTIME } : {}),
    });

    const conn = await connectTarget({ command: "docker", args: targetArgs, serverRef: `npm/${pkgSpec}` });
    try {
      const { tools } = await conn.client.listTools();
      for (const t of tools) {
        await exerciseTool(conn.client, { name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? null });
      }
    } finally {
      await conn.teardown();
    }

    const logs = await docker(["logs", sink]);
    return { ran: true, reason: null, attempts: parseSinkholeOutput(logs) };
  } catch (err) {
    return notRan(`egress sandbox unavailable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Remove containers BEFORE the network (a still-attached container blocks
    // `network rm`) and BEFORE the staging volume (a running container holds it).
    await docker(["rm", "-f", targetName]).catch(() => {});
    await docker(["rm", "-f", sink]).catch(() => {});
    await docker(["network", "rm", net]).catch(() => {});
    if (staged) await staged.cleanup();
  }
}
