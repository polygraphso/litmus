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
  const isStdio = typeof input !== "string" || !/^https?:\/\//i.test(input);
  // Only prompt when both ends are a real terminal — never on the MCP JSON-RPC
  // pipe or in CI (there the gate fails closed instead of blocking on input).
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  // The litmus path always needs the harness; load it once (it also detects Docker).
  const probes = await import("@polygraph/probes");
  const dockerAvailable = isStdio && interactive ? await probes.isDockerAvailable() : false;

  // Host-execution safety gate: a stdio target launches its OWN code; without
  // Docker isolation that runs on this host. Detect Docker and confirm with the
  // operator when we can; otherwise allow (https / opt-in / env) or refuse.
  const decision = checkHostExec(input, { optIn: unsafeHostExec, dockerAvailable, interactive });
  if (decision.action === "refuse") {
    process.stderr.write(`→ litmus: ${decision.refuse}\n`);
    return 2;
  }
  if (decision.action === "confirm" && !(await promptYesNo(decision.prompt, decision.defaultYes))) {
    process.stderr.write("→ litmus: cancelled.\n");
    return 2;
  }
  const isolation = decision.isolation;
  if (decision.warn) process.stderr.write(`→ ${decision.warn}\n`);

  // Tell the operator we've started and stream phase progress — to stderr, so a
  // `--json` run leaves stdout a clean evidence bundle. A run launches the
  // target's code and takes ~20–60s, so the wait shouldn't look like a hang.
  if (!json) process.stderr.write(`→ running litmus against ${target} … (~20–60s)\n`);
  const onProgress = (done: number, total: number, label: string): void => {
    if (!json) process.stderr.write(`  → [${done}/${total}] ${label}\n`);
  };

  try {
    const bundle = await probes.runLitmus(input, {
      headers,
      allowStateChanging,
      timeoutMs,
      onProgress,
      ...(isolation ? { isolation } : {}),
    });
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

/** Ask a yes/no question on the terminal (prompt + answer on stderr, so stdout
 *  stays a clean evidence bundle). Only called on an interactive TTY. */
async function promptYesNo(prompt: string, defaultYes: boolean): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return isAffirmative(await rl.question(prompt), defaultYes);
  } finally {
    rl.close();
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

export type HostExecDecision =
  | { action: "allow"; isolation?: "none" | "docker"; warn?: string }
  | { action: "confirm"; isolation: "none" | "docker"; defaultYes: boolean; prompt: string; warn?: string }
  | { action: "refuse"; refuse: string };

export interface HostExecGate {
  /** `--unsafe-host-exec` (CLI) / `unsafe_host_exec` (MCP): run host code unsandboxed. */
  optIn: boolean;
  /** Whether a Docker daemon was detected — only consulted for an interactive stdio run. */
  dockerAvailable: boolean;
  /** Whether we may prompt: stdin AND stdout are a TTY. A JSON-RPC pipe (the MCP bin)
   *  or a CI run passes false, so the gate fails closed instead of blocking on input. */
  interactive: boolean;
  /** Escape-hatch wording for the refusal (CLI flag vs MCP param). */
  optInHint?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Host-execution safety gate. Grading a registry ref or a local entry file
 * launches the target's OWN code (`npx`/`uvx`/`node`); without Docker isolation
 * that runs on this host. Decide what to do:
 *
 *   - remote `https://` target, or `LITMUS_STDIO_ISOLATION=docker`, or an explicit
 *     `optIn` ⇒ **allow** (with the resolved isolation);
 *   - otherwise, if we can ask (interactive TTY) ⇒ **confirm**: offer the Docker
 *     sandbox when Docker is present (default yes), else ask the operator to type
 *     "yes" to accept host execution (default no);
 *   - otherwise (non-interactive: CI, or the MCP JSON-RPC pipe) ⇒ **refuse**, so a
 *     trust tool is never silently unsafe-by-default and never blocks on a prompt.
 *
 * Mirrors the harness's `isStdio`/isolation resolution; pure so it stays testable.
 */
export function checkHostExec(input: string | StdioCommand, gate: HostExecGate): HostExecDecision {
  const { optIn, dockerAvailable, interactive, optInHint = "--unsafe-host-exec", env = process.env } = gate;
  const isStdio = typeof input !== "string" || !/^https?:\/\//i.test(input);
  if (!isStdio) return { action: "allow" }; // remote https: no host code runs
  if (env.LITMUS_STDIO_ISOLATION === "docker") return { action: "allow", isolation: "docker" };

  const why = "this launches the target's own code; without Docker isolation it runs on THIS host";
  const warn = `⚠ unsafe host execution — ${why}.`;
  if (optIn) return { action: "allow", isolation: "none", warn };

  if (interactive) {
    if (dockerAvailable) {
      return {
        action: "confirm",
        isolation: "docker",
        defaultYes: true,
        prompt: "Docker detected — the target will run sandboxed (recommended). Proceed? [Y/n] ",
      };
    }
    return {
      action: "confirm",
      isolation: "none",
      defaultYes: false,
      prompt:
        "No Docker found — this would run the target's own code on THIS host, unsandboxed.\n" +
        '  Type "yes" to proceed, or set LITMUS_STDIO_ISOLATION=docker to sandbox: ',
      warn,
    };
  }

  return {
    action: "refuse",
    refuse:
      `refusing host execution — ${why}.\n` +
      `  • sandboxed (recommended): set LITMUS_STDIO_ISOLATION=docker (requires Docker)\n` +
      `  • accept the risk: re-run with ${optInHint}`,
  };
}

/** Interpret a yes/no answer; empty input takes `defaultYes`. */
export function isAffirmative(answer: string, defaultYes: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (a === "") return defaultYes;
  return a === "y" || a === "yes";
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
