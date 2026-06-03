/**
 * Shared helpers for exercising a tool surface: build a minimal bait call from
 * a tool's inputSchema, and flatten an MCP result to scannable text. Used by
 * the dynamic probes (C-01 1.2, C-03 4.1).
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDef } from "@polygraph/core";

export const BAIT_STRING = "polygraph litmus bait input";

/** Build minimal arguments from a JSON-schema-ish inputSchema for a bait call. */
export function buildBaitArgs(schema: unknown): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (!schema || typeof schema !== "object") return args;
  const s = schema as { properties?: Record<string, unknown>; required?: unknown };
  const props = s.properties && typeof s.properties === "object" ? s.properties : {};
  const required = Array.isArray(s.required) ? (s.required as string[]) : Object.keys(props);
  for (const key of required) args[key] = baitValue(props[key]);
  return args;
}

function baitValue(prop: unknown): unknown {
  const p = (prop ?? {}) as { type?: unknown; enum?: unknown[] };
  if (Array.isArray(p.enum) && p.enum.length > 0) return p.enum[0];
  const type = Array.isArray(p.type) ? p.type[0] : p.type;
  switch (type) {
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return BAIT_STRING;
  }
}

/** Flatten an MCP tool result to text we can scan (text content + structured payload). */
export function stringifyResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const r = result as { content?: unknown };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const c of r.content) {
      if (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
        parts.push((c as { text: string }).text);
      }
    }
  }
  try {
    parts.push(JSON.stringify(result));
  } catch {
    /* circular — ignore */
  }
  return parts.join("\n");
}

/** Call a tool with bait args; returns scannable text, or null if it couldn't be exercised. */
export async function exerciseTool(client: Client, tool: ToolDef): Promise<string | null> {
  try {
    const result = await client.callTool({ name: tool.name, arguments: buildBaitArgs(tool.inputSchema) });
    return stringifyResult(result);
  } catch {
    return null;
  }
}
