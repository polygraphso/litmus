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
import type { Finding, ToolDef } from "@polygraph/core";
import { connectTarget } from "../connect/index.js";
import { enumerateTools, type ListToolsClient } from "../harness.js";
import { exerciseTool } from "../probes/exercise.js";
import { canaryMatch } from "../probes/scanners.js";
import { docker, ensureImage, labelFlags, stageNpmPackage } from "./staging.js";
import { orderBinCandidates } from "../connect/bin-candidates.js";
import { hostPortMatches } from "../probes/host-match.js";

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
      // litmus-v5: match host AND port — a declared host reached on an undeclared
      // port is overreach. A host-only pattern still allows any port (back-compat).
      const matchedPattern = allowlist.find((p) => hostPortMatches(c.host!, c.port, p));
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
 *  1. **gateway** (litmus-v4, default): host-level DNAT redirects the target's
 *     off-subnet egress to the sink, capturing EVERY outbound TCP — including a
 *     hard-coded IP literal or DoH to a fixed resolver IP — closing the DNS-routed
 *     blind spot (litmus-test §7). Because it intercepts below the container
 *     runtime, it works identically under runc and gVisor. Returns `null` (→ fall
 *     back) if host iptables can't be reached, so the run never errors or regresses.
 *  2. **--internal** (legacy fallback): DNS-routed capture only. Used when the host
 *     rules can't be applied, or when `LITMUS_EGRESS_GATEWAY=0`.
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

/**
 * Enumerate the FULL (paginated) tool surface over `client` and exercise each
 * tool. Uses the same `enumerateTools` pagination as grading and the live
 * fingerprint, so a tool hidden behind `nextCursor` is still exercised — and its
 * egress/canary captured — not just page 1. A single `listTools()` here would let
 * a network-active tool on page 2+ go unexercised, overstating C-02/C-03 safety.
 * Exported so the full-surface guarantee is unit-testable without Docker.
 */
export async function exerciseSurface(
  client: ListToolsClient,
  exercise: (def: ToolDef) => Promise<unknown>,
): Promise<void> {
  for (const t of await enumerateTools(client)) {
    await exercise({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? null });
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
    await exerciseSurface(conn.client, (def) => exerciseTool(conn.client, def));
  } finally {
    await conn.teardown();
  }
  const logs = await docker(["logs", sink]);
  return { ran: true, reason: null, attempts: parseSinkholeOutput(logs), declaredEgress, baselineAllowlist };
}

/**
 * Gateway capture via HOST-DNAT (litmus-v4): the target runs NORMALLY (its own
 * netns, no route tricks), and every off-subnet TCP packet it emits is intercepted
 * at the HOST and redirected to the sink — so a hard-coded IP literal or DoH to a
 * fixed resolver IP is captured just like a DNS-routed connection (litmus-test §7).
 * The interception is below the container runtime, so it works IDENTICALLY under
 * runc and gVisor (unlike an in-netns route change, which gVisor's netstack ignores
 * — verified on the runner) — which is what keeps a hosted grade matching a local one.
 *
 * Three host rules, scoped to THIS run's bridge, added BEFORE the target starts
 * (so there is never an un-DNATed egress window) and removed in `finally`:
 *   - nat PREROUTING DNAT  — off-subnet TCP from the bridge → sink:8443
 *   - nat POSTROUTING MASQUERADE — sink-bound traffic SNAT'd to the host, so the
 *     sink's reply returns via the host (where conntrack un-NATs it) instead of going
 *     L2-direct to the target with the wrong source (which would fail the handshake)
 *   - FORWARD ACCEPT — the in+out-same-bridge hairpin
 * They are applied by an EPHEMERAL `--network host` NET_ADMIN helper that runs ONLY
 * fixed iptables commands over Docker-derived values (bridge/subnet/sink — no
 * untrusted input); the untrusted target stays in its own cap-dropped container.
 *
 * Returns null (→ fall back to --internal) if the host rules can't be applied, so a
 * box without host-iptables access (or `LITMUS_EGRESS_GATEWAY=0`) never regresses.
 */
async function runGatewayCapture(common: EgressCommon): Promise<EgressResult | null> {
  const net = `pg-egw-${randomUUID().slice(0, 8)}`;
  const sink = `pg-sink-${randomUUID().slice(0, 8)}`;
  const targetName = `pg-target-${randomUUID().slice(0, 8)}`;
  let rules: HostDnatScope | null = null;
  try {
    // Regular bridge (NOT --internal, so off-subnet frames reach the host where we
    // intercept them) with Docker's own masquerade OFF — we add a targeted one.
    await docker(["network", "create", "-o", "com.docker.network.bridge.enable_ip_masquerade=false", ...common.label, net]);
    const netId = (await docker(["network", "inspect", "-f", "{{.Id}}", net])).trim();
    const bridge = `br-${netId.slice(0, 12)}`;
    const subnet = (await docker(["network", "inspect", "-f", "{{(index .IPAM.Config 0).Subnet}}", net])).trim();

    // Sink: the one TRUSTED root component (NET_ADMIN + iptables + port 53), with
    // forwarding OFF so it can never relay a captured packet onward to the internet.
    await docker([
      "run", "-d", "--name", sink, "--network", net, ...common.label,
      "--cap-add=NET_ADMIN", "--sysctl", "net.ipv4.ip_forward=0", "--pids-limit", "64", "--memory", "256m",
      "--entrypoint", "/sink-entrypoint.sh", IMAGE_TAG,
    ]);
    const sinkIp = (await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, sink])).trim();
    if (!sinkIp || !bridge || !subnet) return null;

    // Add the host capture rules BEFORE the target starts — no un-DNATed egress window.
    const scope: HostDnatScope = { bridge, subnet, sinkIp };
    if (!(await applyHostDnat(scope, common.label))) return null;
    rules = scope;

    // Target runs NORMALLY (own netns, cap-dropped, --dns sink) — same launch as the
    // --internal path; the host rules, not the target's routing, do the capture.
    const targetArgs = egressTargetArgs({
      targetName, net, sinkIp, vol: common.vol, entry: common.entry, canaryEnv: common.canaryEnv, label: common.label,
      ...(common.runtime ? { runtime: common.runtime } : {}),
    });
    let conn;
    try {
      conn = await connectTarget({ command: "docker", args: targetArgs, serverRef: `npm/${common.pkgSpec}` });
    } catch {
      return null; // connect failed → fall back to the legacy launch.
    }
    return await collectEgress(conn, sink, common.declaredEgress, common.baselineAllowlist);
  } catch {
    return null; // any docker/host error on the gateway path → fall back, never error.
  } finally {
    // Remove the HOST rules first (host state), then the container/network. The
    // target is removed before the rules' bridge so a forwarded packet can't race.
    await docker(["rm", "-f", targetName]).catch(() => {});
    if (rules) await removeHostDnat(rules, common.label).catch(() => {});
    await docker(["rm", "-f", sink]).catch(() => {});
    await docker(["network", "rm", net]).catch(() => {});
  }
}

/** The bridge/subnet/sink a run's host-DNAT rules are scoped to. */
interface HostDnatScope {
  bridge: string;
  subnet: string;
  sinkIp: string;
}

/**
 * Build the iptables commands that add (`-I … 1`) or remove (`-D`) a run's three
 * host-DNAT rules. Pure + symmetric (add/remove share this), and scoped to the
 * run's own bridge so they can never touch another grade's network. Exported for
 * unit testing the exact rule set.
 */
export function hostDnatCommands(op: "I" | "D", s: HostDnatScope): string[] {
  const at = op === "I" ? "-I" : "-D";
  const pos = op === "I" ? " 1" : "";
  return [
    `iptables -t nat ${at} PREROUTING${pos} -i ${s.bridge} -p tcp ! -d ${s.subnet} -j DNAT --to-destination ${s.sinkIp}:8443`,
    `iptables -t nat ${at} POSTROUTING${pos} -o ${s.bridge} -p tcp -d ${s.sinkIp} --dport 8443 -j MASQUERADE`,
    `iptables ${at} FORWARD${pos} -i ${s.bridge} -o ${s.bridge} -j ACCEPT`,
  ];
}

/** Build the `docker run …` args for the ephemeral host-iptables helper. Pure. The
 *  helper shares the HOST network namespace and holds NET_ADMIN, but runs ONLY the
 *  fixed `hostDnatCommands` over Docker-derived values — no untrusted input. */
export function hostDnatHelperArgs(op: "I" | "D", s: HostDnatScope, label: string[]): string[] {
  return [
    "run", "--rm", "--network", "host", "--cap-add=NET_ADMIN", "--cap-drop=ALL", ...label,
    "--entrypoint", "sh", IMAGE_TAG, "-c", hostDnatCommands(op, s).join("; "),
  ];
}

/** Apply the run's host-DNAT rules. Returns false if the helper can't run them (no
 *  host-iptables access) so the caller falls back to the --internal capture. */
async function applyHostDnat(s: HostDnatScope, label: string[]): Promise<boolean> {
  try {
    await docker(hostDnatHelperArgs("I", s, label));
    return true;
  } catch {
    return false;
  }
}

/** Remove the run's host-DNAT rules (best-effort; symmetric to applyHostDnat). */
async function removeHostDnat(s: HostDnatScope, label: string[]): Promise<void> {
  await docker(hostDnatHelperArgs("D", s, label)).catch(() => {});
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

