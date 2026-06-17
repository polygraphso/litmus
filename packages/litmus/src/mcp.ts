#!/usr/bin/env node
/**
 * `polygraphso-litmus-mcp` — the polygraph litmus MCP server. Stdio transport.
 * Exposes to any MCP client (Claude Desktop, Cursor, …):
 *
 *   • `run_litmus`         — actively grade an MCP server A–F against the open harness.
 *   • `verify_attestation` — passively read a server's published onchain grade.
 *   • prompts `grade` / `check` — one-line slash-command entry points to the two tools.
 *
 * Also exported as `@polygraphso/litmus/mcp` for embedding in a custom server.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
        "polygraph runs an open behavioral test on an MCP server and reports a",
        "letter grade A–F, with the evidence behind it.",
        "",
        "Use `run_litmus` to grade a server now. It connects the way an agent would",
        "and exercises the target — so it runs the target's code (egress-sandboxed",
        "when Docker is present), not a passive read; ~20–60s. No wallet or RPC",
        "needed. Pass `server_ref` as an npm ref (npm/@scope/server), an https:// MCP",
        "URL, or a local path to an MCP entry file; pass `bearer` for a token-gated",
        "https target.",
        "",
        "Use `verify_attestation` to read a grade that was already published for a",
        "server, without running anything. Grade publishing is still rolling out, so",
        "it commonly returns not_available today — that means unevaluated (neither",
        "safe nor unsafe), not a failing grade; to grade the server yourself, use",
        "`run_litmus`.",
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

  // Prompts surface as slash commands (in Claude Code: `/mcp__polygraph-litmus__grade`
  // and `…__check`), giving a discoverable one-liner entry point to each tool.
  server.registerPrompt(
    "grade",
    {
      title: "Grade an MCP server",
      description: "Run the open behavioral litmus against an MCP server and report its grade A–F with the evidence.",
      argsSchema: {
        server_ref: z
          .string()
          .min(1)
          .max(512)
          .describe("npm/@scope/server, an https:// MCP URL, or a local path to an MCP entry file"),
      },
    },
    ({ server_ref }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Run the polygraph litmus on ${server_ref} using the run_litmus tool. ` +
              "Report the letter grade, the one-line summary, and any failed category with its findings. " +
              "If the grade is capped at B because Docker was unavailable, say so plainly.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "check",
    {
      title: "Check a server's published grade",
      description: "Read a server's already-published polygraph grade without running anything.",
      argsSchema: {
        server_ref: z
          .string()
          .min(1)
          .max(512)
          .describe("Registry-prefixed server identifier, e.g. npm/@scope/server"),
      },
    },
    ({ server_ref }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Use the verify_attestation tool to read the published polygraph grade for ${server_ref}. ` +
              "If it returns not_available, say the server is unevaluated (neither safe nor unsafe) and offer to run a live grade with run_litmus. " +
              "If it returns lookup_failed, say the lookup itself failed so the grade is unknown — do not call it unevaluated.",
          },
        },
      ],
    }),
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
