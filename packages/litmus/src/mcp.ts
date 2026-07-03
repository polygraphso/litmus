#!/usr/bin/env node
/**
 * `polygraphso-litmus-mcp` — the polygraph MCP server. Stdio transport.
 * Exposes to any MCP client (Claude Desktop, Cursor, …):
 *
 *   • `check_server`       — sub-second read of a server's published grade on polygraph.so.
 *   • `list_servers`       — every server with a published grade, A first.
 *   • `request_grade`      — queue an ungraded server for grading (free, best-effort).
 *   • `run_litmus`         — actively grade an MCP server A–F against the open harness.
 *   • `run_skill_litmus`   — statically grade a Claude Code skill A/B/D/F.
 *   • `verify_attestation` / `verify_skill_attestation` — read the onchain proof.
 *   • prompts `grade` / `check` / `grade-skill` / `check-skill` — slash-command entry points.
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
  VERIFY_SKILL_TOOL_NAME,
  VERIFY_SKILL_TOOL_TITLE,
  VERIFY_SKILL_TOOL_DESCRIPTION,
  verifySkillInputShape,
  handleVerifySkill,
  CHECK_SERVER_TOOL_NAME,
  CHECK_SERVER_TOOL_TITLE,
  CHECK_SERVER_TOOL_DESCRIPTION,
  checkServerInputShape,
  handleCheckServer,
  LIST_SERVERS_TOOL_NAME,
  LIST_SERVERS_TOOL_TITLE,
  LIST_SERVERS_TOOL_DESCRIPTION,
  handleListServers,
  REQUEST_GRADE_TOOL_NAME,
  REQUEST_GRADE_TOOL_TITLE,
  REQUEST_GRADE_TOOL_DESCRIPTION,
  requestGradeInputShape,
  handleRequestGrade,
  clientAgent,
} from "@polygraph/mcp";
import {
  RUN_LITMUS_TOOL_NAME,
  RUN_LITMUS_TOOL_TITLE,
  RUN_LITMUS_TOOL_DESCRIPTION,
  runLitmusInputShape,
  handleRunLitmus,
} from "./tools/run-litmus.js";
import {
  RUN_SKILL_LITMUS_TOOL_NAME,
  RUN_SKILL_LITMUS_TOOL_TITLE,
  RUN_SKILL_LITMUS_TOOL_DESCRIPTION,
  runSkillLitmusInputShape,
  handleRunSkillLitmus,
} from "./tools/run-skill-litmus.js";
import { judgeFromEnv } from "@polygraph/probes";
import { samplingJudge, clientSupportsSampling } from "./sampling-judge.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "polygraph-litmus", version: "0.1.0" },
    {
      instructions: [
        "polygraph runs an open behavioral test on an MCP server and reports a",
        "letter grade A–F, with the evidence behind it.",
        "",
        "Use `check_server` FIRST when the question is whether a server is safe to",
        "recommend or install: it reads the published grade from polygraph.so in",
        "under a second, no execution. `list_servers` enumerates everything graded,",
        "A first. A server with no published grade is unevaluated — neither safe",
        "nor unsafe; say so.",
        "",
        "When `check_server` returns not_available you have two moves:",
        "`request_grade` adds the server to polygraph's public grading queue (free,",
        "best-effort — check back later), or `run_litmus` grades it yourself right",
        "now. `run_litmus` connects the way an agent would and exercises the target —",
        "it runs the target's code (egress-sandboxed when Docker is present), not a",
        "passive read; ~20–60s. Pass `server_ref` as an npm ref (npm/@scope/server),",
        "an https:// MCP URL, or a local path to an MCP entry file; pass `bearer`",
        "for a token-gated https target.",
        "",
        "Use `verify_attestation` to read the ONCHAIN proof behind a grade (EAS on",
        "Base) — the reproducible record, distinct from the fast `check_server`",
        "lookup. Attestation publishing is still rolling out, so it commonly returns",
        "not_available even for servers `check_server` shows as graded.",
        "",
        "Use `run_skill_litmus` to grade a Claude Code / Agent Skill (a SKILL.md +",
        "bundle) A/B/D/F. This is a STATIC read of the skill's text and bundled files —",
        "no execution, no network — so it is fast but not behavioral proof. Pass",
        "`skill_ref` as a local path to the skill directory.",
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
    RUN_SKILL_LITMUS_TOOL_NAME,
    {
      title: RUN_SKILL_LITMUS_TOOL_TITLE,
      description: RUN_SKILL_LITMUS_TOOL_DESCRIPTION,
      inputSchema: runSkillLitmusInputShape,
      annotations: {
        title: RUN_SKILL_LITMUS_TOOL_TITLE,
        readOnlyHint: true, // never mutates: the safety scan reads files; quality judging is host-mediated
        destructiveHint: false,
        idempotentHint: false, // the optional LLM-judged quality axes are non-deterministic
        openWorldHint: true, // the optional quality judge may use the host model (sampling) or a configured endpoint
      },
    },
    // Resolve the judge per call (the client connection is known now): the host
    // agent's model via sampling if it's offered, else an operator-set env key,
    // else null ⇒ deterministic quality only. The litmus core never needs a key.
    (args) =>
      handleRunSkillLitmus(args, {
        judge: clientSupportsSampling(server) ? samplingJudge(server) : judgeFromEnv(),
      }),
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

  server.registerTool(
    VERIFY_SKILL_TOOL_NAME,
    {
      title: VERIFY_SKILL_TOOL_TITLE,
      description: VERIFY_SKILL_TOOL_DESCRIPTION,
      inputSchema: verifySkillInputShape,
      annotations: {
        title: VERIFY_SKILL_TOOL_TITLE,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true, // reads the grade index + chain
      },
    },
    handleVerifySkill,
  );

  server.registerTool(
    CHECK_SERVER_TOOL_NAME,
    {
      title: CHECK_SERVER_TOOL_TITLE,
      description: CHECK_SERVER_TOOL_DESCRIPTION,
      inputSchema: checkServerInputShape,
      annotations: {
        title: CHECK_SERVER_TOOL_TITLE,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true, // reads polygraph.so's published-grade index
      },
    },
    (args) => handleCheckServer(args, clientAgent(server)),
  );

  server.registerTool(
    LIST_SERVERS_TOOL_NAME,
    {
      title: LIST_SERVERS_TOOL_TITLE,
      description: LIST_SERVERS_TOOL_DESCRIPTION,
      annotations: {
        title: LIST_SERVERS_TOOL_TITLE,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    () => handleListServers(clientAgent(server)),
  );

  server.registerTool(
    REQUEST_GRADE_TOOL_NAME,
    {
      title: REQUEST_GRADE_TOOL_TITLE,
      description: REQUEST_GRADE_TOOL_DESCRIPTION,
      inputSchema: requestGradeInputShape,
      annotations: {
        title: REQUEST_GRADE_TOOL_TITLE,
        readOnlyHint: false, // writes a row to the public grading queue
        destructiveHint: false,
        idempotentHint: true, // re-requesting the same target is a no-op
        openWorldHint: true,
      },
    },
    // The queue records WHO asked without prompting the user: the connected
    // client's self-reported identity from the initialize handshake.
    (args) => handleRequestGrade(args, clientAgent(server)),
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
              `Use the check_server tool to read the published polygraph grade for ${server_ref}. ` +
              "If it returns a grade, report it; for the onchain proof behind it, verify_attestation reads the attestation. " +
              "If it returns not_available, say the server is unevaluated (neither safe nor unsafe) and offer the next steps: request_grade to queue it, or run_litmus to grade it now. " +
              "If the lookup itself fails, say the grade is unknown — do not call it unevaluated.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "grade-skill",
    {
      title: "Grade a Claude Code skill",
      description: "Run the open static safety litmus over a skill (SKILL.md + bundle) and report its grade A/B/D/F with the evidence.",
      argsSchema: {
        skill_ref: z
          .string()
          .min(1)
          .max(1024)
          .describe("Local path to a skill directory containing SKILL.md, or a public GitHub skill URL / github/<owner>/<repo>#<path>"),
      },
    },
    ({ skill_ref }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Run the polygraph skill litmus on ${skill_ref} using the run_skill_litmus tool. ` +
              "Report the letter grade, the one-line summary, any failed category with its findings, and the contentHash. " +
              "State plainly that this is a static scan, not behavioral proof.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "check-skill",
    {
      title: "Check a skill's published grade",
      description: "Read a skill's already-published polygraph grade without running anything.",
      argsSchema: {
        skill_ref: z
          .string()
          .min(1)
          .max(1024)
          .describe("Skill identifier, e.g. github/<owner>/<repo>#<path> or marketplace/<owner>/<name>"),
      },
    },
    ({ skill_ref }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Use the verify_skill_attestation tool to read the published polygraph grade for ${skill_ref}. ` +
              "If it returns not_available, say the skill is unevaluated (neither safe nor unsafe) and offer to grade a local copy with run_skill_litmus. " +
              "If a grade is returned, report it and remind the user to recompute the skill's contentHash before installing.",
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
