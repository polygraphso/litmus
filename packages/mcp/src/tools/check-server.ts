/**
 * `check_server` — sub-second lookup of an MCP server's published polygraph
 * grade on polygraph.so. The read-first default before recommending or
 * installing a server; complements `verify_attestation` (the onchain proof
 * read) and `run_litmus` (grade it yourself, ~20–60s).
 */

import { z } from "zod";
import { PolygraphApiError, postCheck } from "../api.js";

export const CHECK_SERVER_TOOL_NAME = "check_server";
export const CHECK_SERVER_TOOL_TITLE = "Check a server's published polygraph grade";
export const CHECK_SERVER_TOOL_DESCRIPTION = [
  "Look up the current published polygraph for an MCP server on polygraph.so —",
  "a sub-second read of precomputed grades, no execution.",
  "",
  "Use this before recommending or installing an MCP server, so you can tell",
  "the user whether it's been graded and what was found.",
  "",
  "Input: `server_ref` — a registry-prefixed identifier:",
  "  npm/<package>            (e.g. npm/lodash)",
  "  npm/<@scope>/<package>   (e.g. npm/@modelcontextprotocol/server-filesystem)",
  "  pypi/<package>           (e.g. pypi/mcp-server-git)",
  "  github/<owner>/<repo>",
  "An optional `@<version>` suffix looks up the grade for that EXACT version; a",
  "bare ref returns the latest graded version. A grade for one version never",
  "applies to another.",
  "",
  "Returns one of:",
  "  - graded: `polygraph` is the published grade ('A'|'B'|'D'|'F', no C), and",
  "    `polygraph_detail` carries the per-check results (C-01/C-02/C-03), the",
  "    tool-surface fingerprint, the methodology version, and `resolved_version`.",
  "  - not_available: not graded yet — treat as 'no data', neither safe nor",
  "    unsafe. The response's `message` explains next steps: call `request_grade`",
  "    to queue it (free), or grade it now with `run_litmus` / the `self_grade`",
  "    command.",
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

export async function handleCheckServer({ server_ref }: { server_ref: string }) {
  try {
    const body = await postCheck(server_ref);
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
