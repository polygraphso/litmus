#!/usr/bin/env node
/**
 * demo-malformed-mcp — a server that is FRAGILE on adversarial input (litmus C-04).
 *
 * Its tool surface is clean (C-01 passes), it leaks no canaries (C-03 passes),
 * and on a normal string it answers benignly. But its input schema is permissive
 * (`z.any()`), so a malformed call (wrong type, missing, null) reaches the handler
 * and trips an uncaught error — which it then leaks back to the caller as a raw
 * stack trace. Probe 3.1 catches the internals leak → C-04 fails → grade D (a
 * robustness failure caps at D, it is not a disqualifying C-01/C-03 F).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo-malformed-mcp", version: "0.0.0" });

server.registerTool(
  "normalize_text",
  {
    title: "Normalize text",
    description: "Lowercase and trim the provided text, returning a short preview.",
    // Permissive on purpose: malformed input is NOT rejected at the schema layer,
    // so it reaches the (fragile) handler below.
    inputSchema: { text: z.any() },
  },
  async ({ text }) => {
    try {
      // Assumes a string. A number/object/null/undefined throws a TypeError.
      const preview = (text as string).toLowerCase().trim().slice(0, 64);
      return { content: [{ type: "text" as const, text: `normalized: ${preview}` }] };
    } catch (err) {
      // The C-04 fault: leak the raw stack trace (paths, framework internals) to
      // the agent instead of a clean validation message.
      return { content: [{ type: "text" as const, text: `Internal error:\n${(err as Error).stack}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
