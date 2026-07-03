/**
 * `request_grade` — add an ungraded MCP server to polygraph.so's public
 * grading queue. The natural follow-up when `check_server` returns
 * not_available and running the litmus locally isn't an option.
 *
 * No contact details: the caller is an agent, so the request carries the
 * connected client's self-reported identity (from the MCP handshake) instead
 * of an email. Fulfillment is best-effort; read the result later by calling
 * `check_server` again.
 */

import { z } from "zod";
import { postGradeRequest } from "../api.js";
import { lookupErrorResult } from "./check-server.js";
import type { ClientAgent } from "../client-id.js";

export const REQUEST_GRADE_TOOL_NAME = "request_grade";
export const REQUEST_GRADE_TOOL_TITLE = "Request a polygraph grade for an MCP server";
export const REQUEST_GRADE_TOOL_DESCRIPTION = [
  "Add an MCP server to polygraph.so's public grading queue.",
  "",
  "Use this when `check_server` returns not_available and you want the server",
  "graded without running anything yourself. Free and best-effort — polygraph",
  "runs the litmus and publishes the grade; read it later by calling",
  "`check_server` again. This does not return a grade synchronously. To grade",
  "the server right now instead, use `run_litmus`.",
  "",
  "No contact details are needed. Requesting the same server twice is a no-op,",
  "not a duplicate.",
  "",
  "Input: `server_ref` — the same registry-prefixed identifier `check_server`",
  "takes (npm/@scope/name, pypi/name, github/owner/repo).",
  "",
  "Returns `{ status: 'queued', created, demand }` — `created` is false if it",
  "was already queued, `demand` is how many requests stand behind it.",
].join("\n");

export const requestGradeInputShape = {
  server_ref: z
    .string()
    .min(1)
    .max(512)
    .describe(
      "Registry-prefixed server identifier, e.g. 'npm/@modelcontextprotocol/server-filesystem', 'pypi/mcp-server-git', or 'github/owner/repo'.",
    ),
};

/**
 * @param agent identity of the connected MCP client (name/version + declared
 *   meta from the initialize handshake), recorded so the queue knows who
 *   asked. Undefined fields when the client didn't announce itself.
 */
export async function handleRequestGrade(
  { server_ref }: { server_ref: string },
  agent?: ClientAgent,
) {
  try {
    const body = await postGradeRequest(server_ref, agent);
    const text = body.created
      ? `Queued ${server_ref} for grading (${body.demand} request(s) behind it). It'll be graded best-effort — call check_server again later to read the result.`
      : `${server_ref} was already in the queue (${body.demand} request(s) behind it). Call check_server again later to read the result.`;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: body as unknown as { [key: string]: unknown },
    };
  } catch (err) {
    return lookupErrorResult(err);
  }
}
