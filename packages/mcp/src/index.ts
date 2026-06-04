#!/usr/bin/env node
/**
 * `@polygraph/mcp` — polygraph's own MCP server. Stdio transport. Exposes
 * `verify_attestation` so any agent can read a server's onchain polygraph as a
 * tool before trusting (or paying) it.
 */

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  VERIFY_TOOL_NAME,
  VERIFY_TOOL_TITLE,
  VERIFY_TOOL_DESCRIPTION,
  verifyInputShape,
  handleVerify,
} from "./tools/verify-attestation.js";

// Re-export the verify tool's pieces so the published `@polygraphso/litmus`
// bundle can register it on its own server alongside the new `run_litmus` tool.
export {
  VERIFY_TOOL_NAME,
  VERIFY_TOOL_TITLE,
  VERIFY_TOOL_DESCRIPTION,
  verifyInputShape,
  handleVerify,
} from "./tools/verify-attestation.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "polygraph", version: "0.0.0" },
    {
      instructions: [
        "polygraph issues behavioral litmus grades for MCP servers, published",
        "onchain. Use `verify_attestation` to read a server's grade before",
        "recommending, installing, or paying it. A server with no attestation is",
        "unevaluated — neither safe nor unsafe; say so.",
      ].join("\n"),
    },
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
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`polygraph-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
