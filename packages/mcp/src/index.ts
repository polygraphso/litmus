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
import {
  CHECK_SERVER_TOOL_NAME,
  CHECK_SERVER_TOOL_TITLE,
  CHECK_SERVER_TOOL_DESCRIPTION,
  checkServerInputShape,
  handleCheckServer,
} from "./tools/check-server.js";
import {
  LIST_SERVERS_TOOL_NAME,
  LIST_SERVERS_TOOL_TITLE,
  LIST_SERVERS_TOOL_DESCRIPTION,
  handleListServers,
} from "./tools/list-servers.js";
import {
  REQUEST_GRADE_TOOL_NAME,
  REQUEST_GRADE_TOOL_TITLE,
  REQUEST_GRADE_TOOL_DESCRIPTION,
  requestGradeInputShape,
  handleRequestGrade,
} from "./tools/request-grade.js";
import { clientAgentId } from "./client-id.js";

// Re-export the verify tool's pieces so the published `@polygraphso/litmus`
// bundle can register it on its own server alongside the new `run_litmus` tool.
export {
  VERIFY_TOOL_NAME,
  VERIFY_TOOL_TITLE,
  VERIFY_TOOL_DESCRIPTION,
  verifyInputShape,
  handleVerify,
} from "./tools/verify-attestation.js";

// The skill-attestation verify tool (litmus-skill-v1), likewise registered by the
// published bundle alongside run_skill_litmus.
export {
  VERIFY_SKILL_TOOL_NAME,
  VERIFY_SKILL_TOOL_TITLE,
  VERIFY_SKILL_TOOL_DESCRIPTION,
  verifySkillInputShape,
  handleVerifySkill,
} from "./tools/verify-skill-attestation.js";

// The published-grade lookup tools (previously shipped separately as
// @polygraphso/mcp, now deprecated): sub-second reads of polygraph.so's
// precomputed grades + the public grading queue. Registered by the published
// bundle alongside the run/verify tools.
export {
  CHECK_SERVER_TOOL_NAME,
  CHECK_SERVER_TOOL_TITLE,
  CHECK_SERVER_TOOL_DESCRIPTION,
  checkServerInputShape,
  handleCheckServer,
} from "./tools/check-server.js";
export {
  LIST_SERVERS_TOOL_NAME,
  LIST_SERVERS_TOOL_TITLE,
  LIST_SERVERS_TOOL_DESCRIPTION,
  handleListServers,
} from "./tools/list-servers.js";
export {
  REQUEST_GRADE_TOOL_NAME,
  REQUEST_GRADE_TOOL_TITLE,
  REQUEST_GRADE_TOOL_DESCRIPTION,
  requestGradeInputShape,
  handleRequestGrade,
} from "./tools/request-grade.js";
export { clientAgentId } from "./client-id.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "polygraph", version: "0.0.0" },
    {
      instructions: [
        "polygraph issues behavioral litmus grades for MCP servers. Use",
        "`check_server` to read a server's published grade before recommending",
        "or installing it; use `verify_attestation` for the onchain proof; use",
        "`request_grade` to queue an ungraded server. A server with no grade is",
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
        openWorldHint: true,
      },
    },
    handleCheckServer,
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
    handleListServers,
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
    (args) => handleRequestGrade(args, clientAgentId(server)),
  );

  return server;
}
