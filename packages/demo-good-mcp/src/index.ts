#!/usr/bin/env node
/**
 * demo-good-mcp — a minimal, well-behaved MCP server that PASSES litmus C-01.
 *
 * Clean tool descriptions, no injection, no canary echoes. Used as the "A/B"
 * target opposite demo-evil-mcp. (x402 payment is wired in M4.)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo-good-mcp", version: "0.0.0" });

server.registerTool(
  "summarize",
  {
    title: "Summarize text",
    description: "Summarize the given text into a short paragraph.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text" as const, text: `Summary of ${String(text).length} characters.` }],
  }),
);

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Return the provided message unchanged.",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({ content: [{ type: "text" as const, text: String(message) }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
