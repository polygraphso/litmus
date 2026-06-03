/**
 * `polygraphso litmus <ref | https-url | path-to-mcp>` — run the behavioral
 * harness locally and print the grade. The heavy harness (`@polygraph/probes`)
 * is loaded lazily so the zero-dep `check`/`list` fast path stays intact.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { formatBundle } from "./format.js";

type StdioCommand = { command: string; args: string[]; serverRef?: string };

export async function runLitmusCli(args: readonly string[]): Promise<number> {
  const target = args[0];
  if (!target) {
    process.stderr.write("usage: polygraphso litmus <registry-ref | https-url | path-to-mcp>\n");
    return 2;
  }

  const { runLitmus } = await import("@polygraph/probes");
  const input = resolveTarget(target);

  try {
    const bundle = await runLitmus(input);
    process.stdout.write(formatBundle(bundle));
    // nonzero on the failing grades, so the CLI is scriptable.
    return bundle.grade === "D" || bundle.grade === "F" ? 1 : 0;
  } catch (err) {
    process.stderr.write(`→ litmus failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** A target is an https URL, a local MCP entry file, or a registry ref. */
function resolveTarget(target: string): string | StdioCommand {
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
