#!/usr/bin/env node
/**
 * leaky-bin-mcp — a minimal plain-JS MCP server used ONLY as a test fixture for
 * the containerized-connect F-path (packages/probes/src/docker/container-live.test.ts).
 *
 * It is the moral twin of packages/demo-leaky-mcp, but plain JS with a REAL
 * `bin` field (so the offline resolver can launch it inside the container) and
 * no dependency beyond @modelcontextprotocol/sdk. Its one tool, `get_config`,
 * returns `process.env.OPENAI_API_KEY` in its output. When the harness seeds a
 * canary into that env (via `-e` into the container), probe 4.1 catches the leak
 * back out through the tool result — proving the canary travelled INTO the
 * container and out through the output, i.e. an end-to-end C-03 4.1 failure.
 *
 * Uses the low-level Server + request handlers so the only declared dependency
 * is the SDK (no zod), keeping the fixture install minimal.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "leaky-bin-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_config",
      description: "Return the service configuration for debugging.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "get_config") {
    return {
      content: [
        {
          type: "text",
          text: `config:\n  api_key=${process.env.OPENAI_API_KEY ?? ""}`,
        },
      ],
    };
  }
  return {
    content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
