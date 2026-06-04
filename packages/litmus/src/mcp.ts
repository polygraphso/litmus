#!/usr/bin/env node
/**
 * `polygraphso-litmus-mcp` — the polygraph litmus MCP server. Stdio transport.
 * Exposes two tools to any MCP client (Claude Desktop, Cursor, …):
 *
 *   • `run_litmus`         — actively grade an MCP server A–F, then hand off to mint.
 *   • `verify_attestation` — passively read a server's published onchain grade.
 *
 * Also exported as `@polygraphso/litmus/mcp` for embedding in a custom server.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  VERIFY_TOOL_NAME,
  VERIFY_TOOL_TITLE,
  VERIFY_TOOL_DESCRIPTION,
  verifyInputShape,
  handleVerify,
} from "@polygraph/mcp";
import {
  RUN_LITMUS_TOOL_NAME,
  RUN_LITMUS_TOOL_TITLE,
  RUN_LITMUS_TOOL_DESCRIPTION,
  runLitmusInputShape,
  handleRunLitmus,
} from "./tools/run-litmus.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "polygraph-litmus", version: "0.1.0" },
    {
      instructions: [
        "polygraph issues behavioral litmus grades (A–F) for MCP servers.",
        "",
        "Use `run_litmus` to grade a server now: it runs the open harness against",
        "the target and returns the grade, the evidence, and — when configured — a",
        "mint hand-off URL the human opens to publish the grade onchain. It launches",
        "the target's code (egress-sandboxed when Docker is present), so it is not a",
        "passive read.",
        "",
        "Use `verify_attestation` to read a server's already-published grade before",
        "recommending, installing, or paying it. A server with no attestation is",
        "unevaluated — neither safe nor unsafe; say so.",
      ].join("\n"),
    },
  );

  server.registerTool(
    RUN_LITMUS_TOOL_NAME,
    {
      title: RUN_LITMUS_TOOL_TITLE,
      description: RUN_LITMUS_TOOL_DESCRIPTION,
      inputSchema: runLitmusInputShape,
      annotations: {
        title: RUN_LITMUS_TOOL_TITLE,
        readOnlyHint: false, // launches the target server's code (and maybe Docker)
        destructiveHint: false, // sandboxed; does not intentionally mutate the user's system
        idempotentHint: false, // re-running re-spawns + re-pins
        openWorldHint: true, // reaches arbitrary external servers
      },
    },
    handleRunLitmus,
  );

  server.registerTool(
    VERIFY_TOOL_NAME,
    {
      title: VERIFY_TOOL_TITLE,
      description: VERIFY_TOOL_DESCRIPTION,
      inputSchema: verifyInputShape,
      annotations: {
        title: VERIFY_TOOL_TITLE,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    handleVerify,
  );

  return server;
}

async function main(): Promise<void> {
  await buildServer().connect(new StdioServerTransport());
}

// Start the server only when run as the bin — not when imported as a library.
// realpath comparison resolves the npm `.bin` symlink to this file.
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`polygraphso-litmus-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
