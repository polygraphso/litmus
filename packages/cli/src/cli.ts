#!/usr/bin/env node
/**
 * polygraphso — behavioral litmus grades for MCP servers.
 *
 * Dispatch mirrors core's CLI: `check`/`list` stay zero-dependency; `litmus`
 * lazy-imports the harness.
 */

import { readVersion } from "./version.js";
import { runLitmusCli } from "./litmus.js";
import { runChallengeCli } from "./challenge.js";
import { runCheck } from "./check.js";
import { runList } from "./list.js";

const HELP = `polygraph — behavioral litmus grades for MCP servers.

usage:
  polygraphso litmus    <registry-ref | https-url | path-to-mcp>
  polygraphso challenge <attestation-uid> <registry-ref | https-url | path>
  polygraphso check     <registry-ref>
  polygraphso list
  polygraphso --version
  polygraphso --help

examples:
  polygraphso litmus npm/@modelcontextprotocol/server-filesystem
  polygraphso litmus ./packages/demo-evil-mcp/src/index.ts
  polygraphso check  npm/@modelcontextprotocol/server-filesystem

More at https://polygraph.so
`;

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
  if (cmd === "challenge") return runChallengeCli(argv.slice(1));
  if (cmd === "check") return runCheck(argv.slice(1));
  if (cmd === "list") return runList(argv.slice(1));

  process.stderr.write(`polygraphso: unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`polygraphso: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
