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

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { parseServerRef } from "@polygraph/core";
import type { Finding } from "@polygraph/core";
import { connectTarget } from "../connect/index.js";
import { exerciseTool } from "../probes/exercise.js";
import { canaryMatch } from "../probes/scanners.js";

const IMAGE_TAG = "polygraph-egress-sniff:latest";
const DOCKER_DIR = fileURLToPath(new URL("../../docker", import.meta.url));

// Runs in the staged container (offline): print the absolute path to the target
// package's launch script, read from its package.json `bin`. argv[1] = pkgName.
const BIN_RESOLVER =
  'const p=require("path");const d="/stage/node_modules/"+process.argv[1];' +
  'let b;try{b=require(d+"/package.json").bin}catch{process.exit(0)}' +
  'const r=typeof b==="string"?b:(b&&Object.values(b)[0]);' +
  "if(r)process.stdout.write(p.join(d,r));";

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
    if (!a.firstBytes) continue;
    findings.push(...canaryMatch(a.firstBytes, canaries));
  }
  return findings;
}

export interface EgressProbeOptions {
  /** Canary env to seed into the target container (so 4.2 can catch exfil). */
  canaryEnv: Record<string, string>;
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
  const vol = `pg-stage-${randomUUID().slice(0, 8)}`;
  const pkgName = parsed.owner ? `${parsed.owner}/${parsed.name}` : parsed.name;

  try {
    await docker(["build", "-t", IMAGE_TAG, "-f", path.join(DOCKER_DIR, "egress-sniff.Dockerfile"), DOCKER_DIR], 180_000);

    // Prep (network ON): install the target + its full dependency tree into a
    // volume, so the sandboxed run needs no internet. Egress detection only means
    // something once the package is staged offline — otherwise the package fetch
    // is itself the (expected) egress and the server never even starts. Exits when done.
    //
    // SECURITY: --ignore-scripts skips the package's install/postinstall hooks, so
    // NO code from the (possibly hostile) package runs here despite network being on —
    // only npm itself executes. The run stays root (it must write the root-owned
    // volume) but with caps dropped + no-new-privileges + limits. The package's own
    // code only ever runs in the OFFLINE, non-root, sinkholed target container below.
    await docker(["volume", "create", vol]);
    await docker(
      ["run", "--rm", "-v", `${vol}:/stage`,
        "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "1g",
        "--entrypoint", "npm", IMAGE_TAG,
        "install", "--prefix", "/stage", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "error", pkgSpec],
      180_000,
    );

    // Resolve the package's launch script from its `bin` (offline, non-root, our code).
    const entry = (
      await docker([
        "run", "--rm", "-v", `${vol}:/stage`, "--user", "node",
        "--cap-drop=ALL", "--security-opt", "no-new-privileges",
        "--entrypoint", "node", IMAGE_TAG, "-e", BIN_RESOLVER, pkgName,
      ])
    ).trim();
    // No bin (or its entry file was never built because we skip install scripts) →
    // can't launch under sandbox policy. Degrade rather than re-run install WITH scripts.
    if (!entry) return notRan(`target package ${pkgName} exposes no launchable bin under the sandbox policy (install scripts are skipped)`);

    // Sinkhole on an --internal network (no route out; DNS + catch-all → sink).
    await docker(["network", "create", "--internal", net]);
    // The sink is the one TRUSTED, root component (needs NET_ADMIN + iptables +
    // privileged port 53), isolated on the --internal net; still resource-bounded.
    await docker([
      "run", "-d", "--name", sink, "--network", net,
      "--cap-add=NET_ADMIN", "--pids-limit", "64", "--memory", "256m",
      "--entrypoint", "/sink-entrypoint.sh", IMAGE_TAG,
    ]);
    const sinkIp = (await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, sink])).trim();

    // Target: NON-ROOT (node uid 1000, shipped by node:22-slim), caps dropped,
    // read-only rootfs, DNS → sinkhole, no internet; runs the staged install OFFLINE
    // so any outbound is the server's own (a C-02 finding). /tmp is the only writable
    // path (mode 1777 so the non-root user can use it).
    const envFlags = Object.entries(opts.canaryEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const targetArgs = [
      "run", "-i", "--rm", "--network", net, "--dns", sinkIp, "-v", `${vol}:/stage:ro`,
      "--user", "node", "--read-only", "--tmpfs", "/tmp:rw,mode=1777", "--cap-drop=ALL",
      "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "512m", ...envFlags,
      "--entrypoint", "node", IMAGE_TAG, entry,
    ];

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
    await docker(["rm", "-f", sink]).catch(() => {});
    await docker(["network", "rm", net]).catch(() => {});
    await docker(["volume", "rm", vol]).catch(() => {});
  }
}

function docker(args: string[], timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args[0]} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}
