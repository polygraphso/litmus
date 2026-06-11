/**
 * `polygraphso litmus <ref | https-url | path-to-mcp>` — run the behavioral
 * harness locally and print the grade. The heavy harness (`@polygraph/probes`)
 * is loaded lazily so the zero-dep `check`/`list` fast path stays intact.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { canonicalStringify, type EvidenceBundle } from "@polygraph/core";
import { formatBundle } from "./format.js";
import { mintUrl, pinUrl } from "./api.js";

type StdioCommand = { command: string; args: string[]; serverRef?: string };

export async function runLitmusCli(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const { headers, allowStateChanging, positionals } = parseAuthFlags(args);
  const target = positionals[0];
  if (!target) {
    process.stderr.write(
      'usage: polygraphso litmus [--json] [--bearer <token>] [--header "Key: Value"] [--allow-state-changing] <registry-ref | https-url | path-to-mcp>\n',
    );
    return 2;
  }

  const { runLitmus } = await import("@polygraph/probes");
  const input = resolveTarget(target);

  try {
    const bundle = await runLitmus(input, { headers, allowStateChanging });
    // `--json` emits the canonical evidence bundle for machines/agents; the
    // default stays the human `→ ` voice. Pinning behaves the same either way.
    process.stdout.write(json ? canonicalStringify(bundle) + "\n" : formatBundle(bundle));
    await maybePin(bundle, json);
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
  let bearer: string | undefined = env.LITMUS_BEARER || undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") continue; // handled by the caller
    if (a === "--allow-state-changing") {
      allowStateChanging = true;
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

  return { headers, allowStateChanging, positionals };
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

/**
 * Pin the bundle + print the mint deep-link, when an API base URL is configured.
 * In `--json` mode the notices go to stderr so stdout stays a single clean JSON
 * document.
 */
async function maybePin(bundle: EvidenceBundle, json = false): Promise<void> {
  if (!process.env.POLYGRAPH_API_URL) return; // opt-in: default runs stay fully offline
  const note = (line: string) => (json ? process.stderr : process.stdout).write(line);
  try {
    const cid = await pinBundle(bundle);
    note(`→ pinned ${cid}\n`);
    note(`→ mint ${mintUrl({ cid, ref: bundle.serverRef, fp: bundle.toolDefsFingerprint })}\n`);
  } catch (err) {
    note(`→ pin skipped: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export async function pinBundle(bundle: EvidenceBundle): Promise<string> {
  const res = await fetch(pinUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalStringify(bundle),
  });
  if (!res.ok) throw new Error(`pin endpoint returned ${res.status}`);
  const data = (await res.json()) as { cid?: string };
  if (!data.cid) throw new Error("pin response missing cid");
  return data.cid;
}
