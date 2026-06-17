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
 * there. The pure log parser and the skip path are unit-tested here.
 */

import { randomUUID } from "node:crypto";
import { parseServerRef } from "@polygraph/core";
import type { Finding } from "@polygraph/core";
import { connectTarget } from "../connect/index.js";
import { exerciseTool } from "../probes/exercise.js";
import { canaryMatch } from "../probes/scanners.js";
import { docker, ensureImage, labelFlags, stageNpmPackage } from "./staging.js";
import { orderBinCandidates } from "../connect/bin-candidates.js";
import { hostMatchesPattern } from "../probes/host-match.js";

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
  /** The target's declared egress (`polygraph.egress`); [] when none/not run. */
  declaredEgress: string[];
  /** The operator baseline allowlist applied to this run; [] when none/not run. */
  baselineAllowlist: string[];
}

function notRan(reason: string): EgressResult {
  return { ran: false, reason, attempts: [], declaredEgress: [], baselineAllowlist: [] };
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

/** An egress attempt with its host resolved (sniffed, or correlated from a
 *  preceding DNS lookup, or unknown). litmus-v3 classifies against the allowlist. */
export interface CorrelatedEgress extends EgressAttempt {
  hostSource: "given" | "dns-correlation" | "none";
}

export interface ClassifiedEgress extends CorrelatedEgress {
  /** Within the effective allowlist (declared ∪ baseline) → not overreach. */
  allowed: boolean;
  /** The allowlist pattern that matched, when allowed. */
  matchedPattern?: string;
}

/**
 * Resolve each egress attempt's host. The sinkhole answers every DNS lookup with
 * its own IP, so a raw TCP attempt (no SNI/Host) lands as port-only; we attribute
 * it to an earlier unconsumed DNS lookup's host. Safe-by-construction: a
 * mis-attribution can only move a connection between two already-resolved hosts,
 * or fall back to "none" (→ conservative overreach) — never invent an allowed host.
 */
export function correlateEgress(attempts: readonly EgressAttempt[]): CorrelatedEgress[] {
  const pendingDnsHosts: string[] = [];
  const out: CorrelatedEgress[] = [];
  for (const a of attempts) {
    if (a.kind === "dns") {
      out.push({ ...a, hostSource: a.host ? "given" : "none" });
      if (a.host) pendingDnsHosts.push(a.host);
    } else if (a.host) {
      out.push({ ...a, hostSource: "given" });
    } else {
      const host = pendingDnsHosts.shift();
      out.push({ ...a, ...(host ? { host } : {}), hostSource: host ? "dns-correlation" : "none" });
    }
  }
  return out;
}

/** Classify correlated egress against the effective allowlist. A host outside the
 *  list — or an attempt with no resolvable host — is overreach. */
export function classifyEgress(correlated: readonly CorrelatedEgress[], allowlist: readonly string[]): ClassifiedEgress[] {
  return correlated.map((c) => {
    if (c.host !== undefined) {
      const matchedPattern = allowlist.find((p) => hostMatchesPattern(c.host!, p));
      return matchedPattern ? { ...c, allowed: true, matchedPattern } : { ...c, allowed: false };
    }
    return { ...c, allowed: false }; // no host → conservative overreach
  });
}

/** Informational (non-failing) findings for egress that was declared/allowed. */
export function egressAllowedFindings(classified: readonly ClassifiedEgress[]): Finding[] {
  return classified
    .filter((c) => c.allowed)
    .map((c) => ({
      kind: "egress-allowed",
      severity: "low",
      match: `${c.host ?? "?"}${c.port ? `:${c.port}` : ""} (allowed: ${c.matchedPattern ?? "?"})`,
      ...(c.host !== undefined ? { host: c.host } : {}),
      ...(c.port !== undefined ? { port: c.port } : {}),
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
  /** Operator baseline egress allowlist (litmus-v3); unioned with the target's
   *  declared egress to decide overreach. Defaults to none. */
  baselineAllowlist?: string[];
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
    "--user", "node", "--read-only", "--tmpfs", "/tmp:rw,size=64m,mode=1777", "--cap-drop=ALL",
    // Disable IPv6 in the target: the sinkhole/iptables capture is IPv4-only, so
    // an IPv6 socket would otherwise dodge detection (and, on a dual-stack net,
    // egress). --cpus bounds host CPU starvation by a hostile busy-loop.
    "--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--sysctl", "net.ipv6.conf.default.disable_ipv6=1",
    "--cpus", "1", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "512m",
    ...opts.label, ...envFlags, ...runtimeFlags,
    "--entrypoint", "node", IMAGE_TAG, opts.entry,
  ];
}

export interface EgressSleeperArgsOptions {
  targetName: string;
  net: string;
  sinkIp: string;
  vol: string;
  label: string[];
  /** Docker runtime override (production: `runsc`/gVisor). */
  runtime?: string;
}

/**
 * Build the `docker run -d …` args for the GATEWAY-mode target sleeper. Same
 * audited hardening as {@link egressTargetArgs} (caps dropped, read-only, non-root,
 * IPv6 off, resource-bounded), but on a REGULAR bridge (so the gateway sink can
 * receive foreign-destination frames — an `--internal` net drops them) and running
 * `sleep` instead of the server. The MCP server is started later via `docker exec`,
 * AFTER the default route has been swapped to the sink — so nothing egresses before
 * capture is in place (no leak window). Canaries are seeded on that `exec`, not
 * here. Pure, so the flag set is unit-testable.
 */
export function egressSleeperArgs(opts: EgressSleeperArgsOptions): string[] {
  const runtimeFlags = opts.runtime ? ["--runtime", opts.runtime] : [];
  return [
    "run", "-d", "--name", opts.targetName, "--network", opts.net, "--dns", opts.sinkIp, "-v", `${opts.vol}:/stage:ro`,
    "--user", "node", "--read-only", "--tmpfs", "/tmp:rw,size=64m,mode=1777", "--cap-drop=ALL",
    "--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--sysctl", "net.ipv6.conf.default.disable_ipv6=1",
    "--cpus", "1", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "512m",
    ...opts.label, ...runtimeFlags,
    "--entrypoint", "sleep", IMAGE_TAG, "3600",
  ];
}

/** Shared inputs for a single egress-capture attempt (gateway or --internal). */
interface EgressCommon {
  pkgSpec: string;
  /** Staged, offline-installed package volume mounted read-only at /stage. */
  vol: string;
  /** The bin entry the connect path grades (mcp-named first). */
  entry: string;
  canaryEnv: Record<string, string>;
  label: string[];
  runtime?: string;
  declaredEgress: string[];
  baselineAllowlist: string[];
}

/**
 * Run the target npm MCP under the egress sandbox and return what it tried to
 * reach. Best-effort: any Docker error degrades to `ran: false`.
 *
 * Two capture strategies, tried in order:
 *  1. **gateway** (litmus-v4, default): the sink is the target's default route and
 *     captures EVERY outbound packet — including a hard-coded IP literal or DoH to
 *     a fixed resolver — closing the DNS-routed blind spot (litmus-test §7). It
 *     self-verifies the route swap and returns `null` if it can't be applied (e.g.
 *     gVisor's separate netstack), so the run never errors or regresses.
 *  2. **--internal** (legacy fallback): DNS-routed capture only. Used when the
 *     gateway route can't be applied, or when `LITMUS_EGRESS_GATEWAY=0`.
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
    // Launch the same bin the connect path grades: the MCP-named bin first (else
    // the package-name bin, else the first). Staging guarantees ≥1 bin.
    const entry = staged.bins[orderBinCandidates(Object.keys(staged.bins), parsed.name)[0]!]!;
    const common: EgressCommon = {
      pkgSpec,
      vol: staged.volume,
      entry,
      canaryEnv: opts.canaryEnv,
      label,
      // The target runs the SAME untrusted package as the main-connect path, so it
      // carries the same gVisor `--runtime` override when configured — runtime parity.
      ...(process.env.LITMUS_DOCKER_RUNTIME ? { runtime: process.env.LITMUS_DOCKER_RUNTIME } : {}),
      declaredEgress: staged.declaredEgress,
      baselineAllowlist: opts.baselineAllowlist ?? [],
    };

    // Gateway capture by default; a `=0` kill switch lets an operator force the
    // legacy path without a redeploy. Gateway returns null (no leak occurred) when
    // the route can't be applied, so we fall back rather than regress.
    if (process.env.LITMUS_EGRESS_GATEWAY !== "0") {
      const gateway = await runGatewayCapture(common);
      if (gateway) return gateway;
    }
    return await runInternalCapture(common);
  } catch (err) {
    return notRan(`egress sandbox unavailable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (staged) await staged.cleanup();
  }
}

/** List + exercise the tool surface over `conn`, then read the sink's capture.
 *  Shared by both capture strategies; tears the connection down in `finally`. */
async function collectEgress(
  conn: Awaited<ReturnType<typeof connectTarget>>,
  sink: string,
  declaredEgress: string[],
  baselineAllowlist: string[],
): Promise<EgressResult> {
  try {
    const { tools } = await conn.client.listTools();
    for (const t of tools) {
      await exerciseTool(conn.client, { name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? null });
    }
  } finally {
    await conn.teardown();
  }
  const logs = await docker(["logs", sink]);
  return { ran: true, reason: null, attempts: parseSinkholeOutput(logs), declaredEgress, baselineAllowlist };
}

/**
 * Gateway-DNAT capture (litmus-v4): a REGULAR bridge with host masquerade OFF + a
 * sink that is the target's default route, so every outbound packet (including a
 * hard-coded IP literal / DoH) is funnelled to the logger, not just DNS-routed
 * connections. Ordering is what makes it leak-safe: the target runs as a SLEEPER
 * first (no server, no egress); a privileged sidecar swaps its default route to the
 * sink; we VERIFY the swap from the target's OWN view; only then is the server
 * started via `docker exec`. If the swap can't be applied (e.g. gVisor's netstack)
 * the server never starts — nothing egressed — and we return `null` to fall back to
 * the legacy `--internal` capture. ANY gateway-path failure returns `null` (never
 * throws), so this path can only ADD capture, never regress a run.
 */
async function runGatewayCapture(common: EgressCommon): Promise<EgressResult | null> {
  const net = `pg-egw-${randomUUID().slice(0, 8)}`;
  const sink = `pg-sink-${randomUUID().slice(0, 8)}`;
  const targetName = `pg-target-${randomUUID().slice(0, 8)}`;
  try {
    // Regular bridge (NOT --internal, so the gateway sink receives foreign-dst
    // frames) with host IP-masquerade DISABLED as defense-in-depth.
    await docker(["network", "create", "-o", "com.docker.network.bridge.enable_ip_masquerade=false", ...common.label, net]);
    // Sink: the one TRUSTED root component (NET_ADMIN + iptables + port 53), with
    // forwarding OFF so it can never relay a captured packet onward to the internet.
    await docker([
      "run", "-d", "--name", sink, "--network", net, ...common.label,
      "--cap-add=NET_ADMIN", "--sysctl", "net.ipv4.ip_forward=0", "--pids-limit", "64", "--memory", "256m",
      "--entrypoint", "/sink-entrypoint.sh", IMAGE_TAG,
    ]);
    const sinkIp = (await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, sink])).trim();
    if (!sinkIp) return null;

    // Target as a sleeper: netns up, no server, no egress yet.
    await docker(
      egressSleeperArgs({ targetName, net, sinkIp, vol: common.vol, label: common.label, ...(common.runtime ? { runtime: common.runtime } : {}) }),
    );

    if (!(await applyAndVerifySinkRoute(targetName, sinkIp, common.runtime, common.label))) {
      return null; // route not applied (sleeper never egressed) → fall back.
    }

    // Route verified safe: start the server via `docker exec` (fresh stdio, no leak
    // window). Canaries are seeded here so a hostile server could try to exfil them.
    const execArgs = [
      "exec", "-i", "--user", "node",
      ...Object.entries(common.canaryEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      targetName, "node", common.entry,
    ];
    let conn;
    try {
      conn = await connectTarget({ command: "docker", args: execArgs, serverRef: `npm/${common.pkgSpec}` });
    } catch {
      return null; // exec launch didn't connect → fall back to the legacy launch.
    }
    return await collectEgress(conn, sink, common.declaredEgress, common.baselineAllowlist);
  } catch {
    return null; // any docker error on the gateway path → fall back, never error.
  } finally {
    await docker(["rm", "-f", targetName]).catch(() => {});
    await docker(["rm", "-f", sink]).catch(() => {});
    await docker(["network", "rm", net]).catch(() => {});
  }
}

/**
 * Legacy `--internal` capture (DNS-routed). No route to the internet at all, so it
 * is leak-proof by construction, but it cannot see a hard-coded IP literal / DoH
 * (those are dropped at routing before reaching the sink — litmus-test §7). The
 * fallback when the gateway route can't be applied; never regresses a run to B.
 */
async function runInternalCapture(common: EgressCommon): Promise<EgressResult> {
  const net = `pg-egress-${randomUUID().slice(0, 8)}`;
  const sink = `pg-sink-${randomUUID().slice(0, 8)}`;
  // A node server over `docker run -i` does NOT exit on stdin close, so `--rm`
  // never fires on `client.close()` alone — name it so the finally can force-remove.
  const targetName = `pg-target-${randomUUID().slice(0, 8)}`;
  try {
    await docker(["network", "create", "--internal", ...common.label, net]);
    await docker([
      "run", "-d", "--name", sink, "--network", net, ...common.label,
      "--cap-add=NET_ADMIN", "--pids-limit", "64", "--memory", "256m",
      "--entrypoint", "/sink-entrypoint.sh", IMAGE_TAG,
    ]);
    const sinkIp = (await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, sink])).trim();
    const targetArgs = egressTargetArgs({
      targetName, net, sinkIp, vol: common.vol, entry: common.entry, canaryEnv: common.canaryEnv, label: common.label,
      ...(common.runtime ? { runtime: common.runtime } : {}),
    });
    const conn = await connectTarget({ command: "docker", args: targetArgs, serverRef: `npm/${common.pkgSpec}` });
    return await collectEgress(conn, sink, common.declaredEgress, common.baselineAllowlist);
  } finally {
    // Remove containers BEFORE the network (a still-attached container blocks
    // `network rm`).
    await docker(["rm", "-f", targetName]).catch(() => {});
    await docker(["rm", "-f", sink]).catch(() => {});
    await docker(["network", "rm", net]).catch(() => {});
  }
}

function egressDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Poll until the named container is running (its netns exists) or time out. */
async function waitForContainerRunning(name: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = (await docker(["inspect", "-f", "{{.State.Running}}", name]).catch(() => "")).trim();
    if (state === "true") return true;
    await egressDelay(100);
  }
  return false;
}

/**
 * Swap the target's default route to the sink and VERIFY it took from the target's
 * OWN network view. The sidecar runs at the target's runtime so a gVisor target
 * shares the same netstack; if the swap doesn't appear in the target's routes
 * (a runtime that isolates the netstack), returns false and the caller falls back.
 * The target itself stays `--cap-drop=ALL` throughout — only the ephemeral sidecar
 * holds NET_ADMIN.
 */
async function applyAndVerifySinkRoute(
  targetName: string,
  sinkIp: string,
  runtime: string | undefined,
  label: string[],
): Promise<boolean> {
  if (!(await waitForContainerRunning(targetName, 15_000))) return false;
  const runtimeFlags = runtime ? ["--runtime", runtime] : [];
  await docker([
    "run", "--rm", "--network", `container:${targetName}`, "--cap-add=NET_ADMIN", ...runtimeFlags, ...label,
    "--entrypoint", "sh", IMAGE_TAG, "-c", `ip route del default 2>/dev/null; ip route add default via ${sinkIp}`,
  ]).catch(() => {});
  const wanted = `default via ${sinkIp} `;
  for (let i = 0; i < 20; i++) {
    const routes = await docker(["exec", targetName, "ip", "route"]).catch(() => "");
    if (routes.split("\n").some((l) => (l + " ").startsWith(wanted))) return true;
    await egressDelay(100);
  }
  return false;
}
