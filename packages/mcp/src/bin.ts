#!/usr/bin/env node
/**
 * `@polygraph/mcp` standalone bin (`polygraph-mcp`) — the verify-only MCP server
 * over stdio. Kept separate from `index.ts` so the package is side-effect-free to
 * import: the `@polygraphso/litmus` bundle imports the tool pieces from `index.ts`
 * and must NOT inherit a self-starting server (that previously raced litmus's own
 * server on stdio and could shadow `run_litmus`).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./index.js";

buildServer()
  .connect(new StdioServerTransport())
  .catch((err: unknown) => {
    process.stderr.write(`polygraph-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
