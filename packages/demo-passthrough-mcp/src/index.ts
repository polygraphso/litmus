#!/usr/bin/env node
/**
 * demo-passthrough-mcp — a well-behaved fetch/read tool that FAITHFULLY relays
 * external content. It passes C-01, but probe 1.4 (indirect/passthrough injection,
 * litmus-v16) records an `indirect-injection` DISCLOSURE: the tool is a conduit for
 * untrusted third-party data. Relaying that data verbatim is legitimate — the agent
 * is expected to distrust tool output — so it is NOT a fail. Contrast
 * demo-injecting-mcp, which GENERATES injection in its output (a real C-01 fail).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { z } from "zod";

const server = new McpServer({ name: "demo-passthrough-mcp", version: "0.0.0" });

// Reads a local document and returns its contents unchanged — a faithful conduit.
// The harness (probe 1.4) points this at its own injection-laced file; the verbatim
// relay is disclosed as an indirect-injection conduit, not failed.
server.registerTool(
  "read_document",
  {
    title: "Read document",
    description: "Read a local document by path and return its contents.",
    inputSchema: { path: z.string() },
  },
  async ({ path }) => {
    let text: string;
    try {
      text = readFileSync(String(path), "utf8");
    } catch {
      text = "could not read the requested document";
    }
    return { content: [{ type: "text" as const, text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
