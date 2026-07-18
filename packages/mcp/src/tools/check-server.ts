/**
 * `check_server` — sub-second lookup of an MCP server's published polygraph
 * grade on polygraph.so. The read-first default before recommending or
 * installing a server; complements `verify_attestation` (the onchain proof
 * read) and `run_litmus` (grade it yourself, ~20–60s).
 */

import { z } from "zod";
import { PolygraphApiError, postCheck } from "../api.js";
import type { ClientAgent } from "../client-id.js";

export const CHECK_SERVER_TOOL_NAME = "check_server";
export const CHECK_SERVER_TOOL_TITLE = "Check a server's published polygraph grade";
export const CHECK_SERVER_TOOL_DESCRIPTION = [
  "Look up an MCP server's published polygraph grade on polygraph.so in under a",
  "second, no execution; call this FIRST, before recommending or installing a",
  "server and before running anything yourself with run_litmus.",
  "",
  "Input: server_ref, a registry-prefixed identifier: npm/<package> (e.g.",
  "npm/lodash), npm/<@scope>/<package>, pypi/<package>, or github/<owner>/<repo>.",
  "An optional @<version> suffix looks up that exact version; a bare ref",
  "returns the latest graded version. A grade for one version never applies",
  "to another.",
  "",
  "Returns graded (polygraph: A/B/C/D/F, plus polygraph_detail with the",
  "per-check results, tool-surface fingerprint, methodology version, and",
  "resolved_version) or not_available (unevaluated, neither safe nor unsafe;",
  "message explains next steps: request_grade to queue it, or run_litmus to",
  "grade it now).",
].join("\n");

export const checkServerInputShape = {
  server_ref: z
    .string()
    .min(1)
    .max(512)
    .describe(
      "Registry-prefixed server identifier, e.g. 'npm/@modelcontextprotocol/server-filesystem', 'pypi/mcp-server-git', or 'github/owner/repo'. An optional '@<version>' suffix looks up that exact version.",
    ),
};

export async function handleCheckServer(
  { server_ref }: { server_ref: string },
  agent?: ClientAgent,
) {
  try {
    const body = await postCheck(server_ref, agent);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
      structuredContent: body as unknown as { [key: string]: unknown },
    };
  } catch (err) {
    return lookupErrorResult(err);
  }
}

/** Shared error shape for the lookup tools: a clean MCP error result, never a
 *  transport crash. A failed lookup means the grade is UNKNOWN — not a verdict. */
export function lookupErrorResult(err: unknown) {
  const msg =
    err instanceof PolygraphApiError
      ? err.message
      : `polygraph.so lookup failed: ${err instanceof Error ? err.message : String(err)}`;
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: msg }],
  };
}
