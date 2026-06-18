/**
 * `polygraphso litmus <ref | https-url | path-to-mcp>` — run the behavioral
 * harness locally and print the grade. The heavy harness (`@polygraph/probes`)
 * is loaded lazily so the zero-dep `check`/`list` fast path stays intact.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { canonicalStringify } from "@polygraph/core";
import { formatBundle } from "./format.js";

export type StdioCommand = { command: string; args: string[]; serverRef?: string };

/**
 * Default aggregate wall-clock ceiling (15 min) for a local/MCP run, matching
 * the hosted runner's `runTimeoutMs`. Without it a hostile server can stretch a
 * run across MAX_TOOLS × per-call timeouts and pin the caller for hours. Override
 * with `--timeout <seconds>` (CLI) / `timeout_seconds` (MCP).
 */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

export async function runLitmusCli(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const { headers, allowStateChanging, unsafeHostExec, timeoutMs, positionals } = parseAuthFlags(args);
  const target = positionals[0];
  if (!target) {
    process.stderr.write(
      'usage: polygraphso litmus [--json] [--bearer <token>] [--header "Key: Value"] [--allow-state-changing] [--unsafe-host-exec] [--timeout <seconds>] <registry-ref | https-url | path-to-mcp>\n',
    );
    return 2;
  }

  const input = resolveTarget(target);

  // Host-execution safety gate: a stdio target (registry ref or local file)
  // launches its OWN code; without Docker isolation that runs on this host.
  // Refuse unless the user opted in or set Docker isolation.
  const guard = checkHostExec(input, unsafeHostExec);
  if (!guard.allow) {
    process.stderr.write(`→ litmus: ${guard.refuse}\n`);
    return 2;
  }
  if (guard.warn) process.stderr.write(`→ ${guard.warn}\n`);

  const { runLitmus } = await import("@polygraph/probes");

  try {
    const bundle = await runLitmus(input, { headers, allowStateChanging, timeoutMs });
    // `--json` emits the canonical evidence bundle for machines/agents; the
    // default stays the human `→ ` voice. Pinning behaves the same either way.
    process.stdout.write(json ? canonicalStringify(bundle) + "\n" : formatBundle(bundle));
    // nonzero on the failing grades, so the CLI is scriptable.
    return bundle.grade === "D" || bundle.grade === "F" ? 1 : 0;
  } catch (err) {
    process.stderr.write(`→ litmus failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export interface ParsedLitmusFlags {
  /** HTTP headers for a remote target (e.g. `Authorization: Bearer …`). */
  headers: Record<string, string>;
  /** Whether to actively call state-changing tools (opt-in). */
  allowStateChanging: boolean;
  /** Opt-in to run a stdio target's code on the host without Docker isolation. */
  unsafeHostExec: boolean;
  /** Aggregate wall-clock ceiling (ms) — `--timeout <seconds>`, else the default. */
  timeoutMs: number;
  /** Non-flag arguments, in order (positionals[0] is the target). */
  positionals: string[];
}

/**
 * Parse the litmus flags into HTTP headers + the state-changing opt-in, and
 * separate out the positional target. Proper parsing (not just "first non-flag
 * arg") matters because `--bearer <token>` takes a value that must not be
 * mistaken for the target.
 *
 * Authorization precedence (last wins): `LITMUS_BEARER` < `--bearer` < `--header`.
 */
export function parseAuthFlags(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedLitmusFlags {
  const headers: Record<string, string> = {};
  const headerArgs: string[] = [];
  let allowStateChanging = false;
  let unsafeHostExec = false;
  let timeoutMs = DEFAULT_RUN_TIMEOUT_MS;
  let bearer: string | undefined = env.LITMUS_BEARER || undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") continue; // handled by the caller
    if (a === "--allow-state-changing") {
      allowStateChanging = true;
    } else if (a === "--unsafe-host-exec") {
      unsafeHostExec = true;
    } else if (a === "--timeout") {
      // Consume the value here so it can't be misread as the positional target.
      timeoutMs = timeoutSecondsToMs(args[++i]) ?? timeoutMs;
    } else if (a.startsWith("--timeout=")) {
      timeoutMs = timeoutSecondsToMs(a.slice("--timeout=".length)) ?? timeoutMs;
    } else if (a === "--bearer") {
      bearer = args[++i] ?? bearer;
    } else if (a.startsWith("--bearer=")) {
      bearer = a.slice("--bearer=".length);
    } else if (a === "--header") {
      const v = args[++i];
      if (v) headerArgs.push(v);
    } else if (a.startsWith("--header=")) {
      headerArgs.push(a.slice("--header=".length));
    } else if (a.startsWith("--")) {
      // Unknown flag — ignore rather than misread it as the target.
    } else {
      positionals.push(a);
    }
  }

  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  // `--header "Key: Value"` overrides the bearer-derived header for the same key.
  for (const h of headerArgs) {
    const idx = h.indexOf(":");
    if (idx === -1) continue; // malformed; skip
    const key = h.slice(0, idx).trim();
    const value = h.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }

  return { headers, allowStateChanging, unsafeHostExec, timeoutMs, positionals };
}

/** `--timeout` takes seconds (human-friendly); convert to ms. Invalid ⇒ undefined (keep default). */
function timeoutSecondsToMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const sec = Number(v);
  return Number.isFinite(sec) && sec > 0 ? Math.floor(sec * 1000) : undefined;
}

export interface HostExecVerdict {
  /** false ⇒ refuse the run (the target would execute on the host unsandboxed). */
  allow: boolean;
  /** Printed before proceeding when the caller opted into host execution. */
  warn?: string;
  /** Printed when refusing (allow=false), explaining how to proceed. */
  refuse?: string;
}

/**
 * Host-execution safety gate. Grading a registry ref or a local entry file
 * launches the target's OWN code (`npx`/`uvx`/`node`); when stdio isolation
 * resolves to "none" (no `LITMUS_STDIO_ISOLATION=docker`) that code runs on this
 * host. Require an explicit opt-in in that case so a trust tool isn't silently
 * unsafe-by-default. Remote `https://` targets (no host code) and Docker-isolated
 * runs are always allowed. Mirrors the harness's `isStdio`/isolation resolution.
 */
export function checkHostExec(
  input: string | StdioCommand,
  optIn: boolean,
  optInHint = "--unsafe-host-exec",
  env: NodeJS.ProcessEnv = process.env,
): HostExecVerdict {
  const isStdio = typeof input !== "string" || !/^https?:\/\//i.test(input);
  const dockerIsolated = env.LITMUS_STDIO_ISOLATION === "docker";
  if (!isStdio || dockerIsolated) return { allow: true };
  const why = "this launches the target's own code; without Docker isolation it runs on THIS host";
  if (optIn) return { allow: true, warn: `⚠ unsafe host execution — ${why}.` };
  return {
    allow: false,
    refuse:
      `refusing host execution — ${why}.\n` +
      `  • sandboxed (recommended): set LITMUS_STDIO_ISOLATION=docker (requires Docker)\n` +
      `  • accept the risk: re-run with ${optInHint}`,
  };
}

/** A target is an https URL, a local MCP entry file, or a registry ref. */
export function resolveTarget(target: string): string | StdioCommand {
  if (/^https?:\/\//i.test(target)) return target;
  if (existsSync(target)) {
    const abs = path.resolve(target);
    if (abs.endsWith(".ts") || abs.endsWith(".mts") || abs.endsWith(".cts")) {
      return { command: process.execPath, args: [tsxCli(), abs], serverRef: target };
    }
    return { command: process.execPath, args: [abs], serverRef: target };
  }
  return target; // registry ref: npm/… · pypi/… · github/…
}

function tsxCli(): string {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("tsx/package.json");
  const dir = path.dirname(pkgJsonPath);
  const bin = (require(pkgJsonPath) as { bin: string | Record<string, string> }).bin;
  const rel = typeof bin === "string" ? bin : (bin.tsx ?? "./dist/cli.mjs");
  return path.join(dir, rel);
}
