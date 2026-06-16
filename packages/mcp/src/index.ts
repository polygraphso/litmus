/**
 * `@polygraph/mcp` — polygraph's own MCP server pieces. Exposes
 * `verify_attestation` so any agent can read a server's onchain polygraph as a
 * tool before trusting (or paying) it.
 *
 * This module is **side-effect-free** (safe to import): the standalone stdio bin
 * lives in `bin.ts`. The published `@polygraphso/litmus` bundle imports the verify
 * tool pieces from here and registers them on its own server alongside `run_litmus`
 * — so importing this must not start a server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
