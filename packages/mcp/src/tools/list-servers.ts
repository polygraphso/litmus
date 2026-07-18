/**
 * `list_servers`: enumerate MCP servers with a published polygraph grade,
 * sorted A-first. The discovery counterpart to `check_server`.
 */

import { z } from "zod";
import type { LitmusGrade } from "@polygraph/core";
import { getList } from "../api.js";
import { lookupErrorResult } from "./check-server.js";
import type { ClientAgent } from "../client-id.js";

export const LIST_SERVERS_TOOL_NAME = "list_servers";
export const LIST_SERVERS_TOOL_TITLE = "List MCP servers with published polygraph grades";
export const LIST_SERVERS_TOOL_DESCRIPTION = [
  "List MCP servers polygraph.so has published a grade for, sorted grade-first",
  "(A first); use it to find well-graded options before recommending one.",
  "",
  "Optional grade (A/B/C/D/F) filters to one letter; limit (1-100, default 25)",
  "and offset page through more. Returns { servers: [{server_ref, polygraph}],",
  "total, summary? }. If the index returns more rows than limit, the extra",
  "rows are trimmed client-side and a one-line note says so.",
].join("\n");

const DEFAULT_LIST_LIMIT = 25;

export const listServersInputShape = {
  grade: z
    .enum(["A", "B", "C", "D", "F"])
    .optional()
    .describe("Filter results to a single letter grade."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max rows to return (default 25)."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Rows to skip, for paging past `limit`."),
};

export interface ListServersArgs {
  grade?: LitmusGrade;
  limit?: number;
  offset?: number;
}

export async function handleListServers(args: ListServersArgs = {}, agent?: ClientAgent) {
  const limit = args.limit ?? DEFAULT_LIST_LIMIT;
  try {
    const body = await getList({ grade: args.grade, limit, offset: args.offset }, agent);
    let servers = body.servers;
    let note: string | undefined;
    // The API rollout for `limit` is independent of this tool: if it ignored
    // the param and returned more rows than asked, enforce the default client-side
    // so a bare call still stays small, and say so rather than silently truncating.
    if (servers.length > limit) {
      const total = body.summary?.total ?? body.total ?? servers.length;
      servers = servers.slice(0, limit);
      note = `showing ${servers.length} of ${total}; pass limit/offset for more.`;
    }
    const payload = { ...body, servers };
    // `text` is human-facing (it appends the paging note below the JSON), so
    // it is not guaranteed pure JSON; machine consumers should read
    // `structuredContent` instead of parsing `text`.
    const text = [JSON.stringify(payload, null, 2), ...(note ? [note] : [])].join("\n");
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: payload as unknown as { [key: string]: unknown },
    };
  } catch (err) {
    return lookupErrorResult(err);
  }
}
