#!/usr/bin/env node
/**
 * `polygraphso-litmus` — behavioral litmus grades for MCP servers (CLI).
 *
 * Dispatch reuses the command handlers from `@polygraph/cli`; they get inlined
 * into this bundle at build time. `litmus` runs the harness; the zero-dependency
 * `check`/`list` hit the published-grades API.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runLitmusCli } from "@polygraph/cli/litmus";
import { runCheck } from "@polygraph/cli/check";
import { runList } from "@polygraph/cli/list";

const HELP = `polygraphso-litmus — behavioral litmus grades for MCP servers.

usage:
  polygraphso-litmus litmus    [--json] <registry-ref | https-url | path-to-mcp>
  polygraphso-litmus check     <registry-ref>
  polygraphso-litmus list
  polygraphso-litmus --version
  polygraphso-litmus --help

examples:
  polygraphso-litmus litmus npm/@modelcontextprotocol/server-filesystem
  polygraphso-litmus litmus --json npm/@modelcontextprotocol/server-filesystem

Set POLYGRAPH_API_URL so check/list can look up a server's published grade.
More at https://polygraph.so
`;

function readVersion(): string {
  try {
    // Resolve the package.json next to dist/ at runtime (not bundled): join keeps
    // esbuild from treating it as a static asset to copy.
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(readVersion() + "\n");
    return 0;
  }
  if (cmd === "litmus") return runLitmusCli(argv.slice(1));
  if (cmd === "check") return runCheck(argv.slice(1));
  if (cmd === "list") return runList(argv.slice(1));

  process.stderr.write(`polygraphso-litmus: unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`polygraphso-litmus: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
