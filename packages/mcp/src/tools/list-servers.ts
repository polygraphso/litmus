/**
 * `list_servers` — enumerate every MCP server with a published polygraph grade,
 * sorted A-first. The discovery counterpart to `check_server`.
 */

import { getList } from "../api.js";
import { lookupErrorResult } from "./check-server.js";
import type { ClientAgent } from "../client-id.js";

export const LIST_SERVERS_TOOL_NAME = "list_servers";
export const LIST_SERVERS_TOOL_TITLE = "List MCP servers with published polygraph grades";
export const LIST_SERVERS_TOOL_DESCRIPTION = [
  "List every MCP server polygraph.so has published a grade for, sorted by",
  "grade (A first).",
  "",
  "Use this to discover which servers have been graded, or to find well-graded",
  "options before recommending one.",
  "",
  "Each entry: `server_ref` (canonical registry-prefixed identifier) and",
  "`polygraph` ('A'|'B'|'D'|'F', no C). Returns `{ servers: [...], total }`.",
  "No input parameters.",
].join("\n");

export async function handleListServers(agent?: ClientAgent) {
  try {
    const body = await getList(agent);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
      structuredContent: body as unknown as { [key: string]: unknown },
    };
  } catch (err) {
    return lookupErrorResult(err);
  }
}
