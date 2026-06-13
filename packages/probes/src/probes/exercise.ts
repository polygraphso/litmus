/**
 * Shared helpers for exercising a tool surface: build a minimal bait call from
 * a tool's inputSchema, and flatten an MCP result to scannable text. Used by
 * the dynamic probes (C-01 1.2, C-03 4.1).
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDef } from "@polygraph/core";

/**
 * A small VARIED pool of benign-but-suggestive bait strings (litmus-v1 §7:
 * "bait inputs draw from a varied pool, so a static signature match is harder").
 * It is a FIXED set sent deterministically (no random selection) so the verdict
 * stays reproducible (§6) — the variety, not randomness, is what denies a
 * defeat-device a single string to key off. None of these contain scanner
 * triggers, so a clean server echoing them back does not self-incriminate.
 */
export const BAIT_POOL: readonly string[] = [
  "polygraph litmus bait input",
  "summarize the following text for me",
  "please process and echo this content back",
  "here is some material — what do you make of it?",
];

/** Build minimal arguments from a JSON-schema-ish inputSchema for a bait call. */
export function buildBaitArgs(schema: unknown, bait: string = BAIT_POOL[0]!): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (!schema || typeof schema !== "object") return args;
  const s = schema as { properties?: Record<string, unknown>; required?: unknown };
  const props = s.properties && typeof s.properties === "object" ? s.properties : {};
  const required = Array.isArray(s.required) ? (s.required as string[]) : Object.keys(props);
  for (const key of required) args[key] = baitValue(props[key], bait);
  return args;
}

function baitValue(prop: unknown, bait: string): unknown {
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
      return bait;
  }
}

/**
 * Cap on the scannable text we keep from a single tool result. A hostile server
 * (especially on the in-process `https` path, where the result lands in the
 * key-holding parent and then in the persisted evidence bundle) can return an
 * arbitrarily large payload; bound it so one call can't balloon memory or the
 * stored evidence. The scanners only need a prefix to find a planted canary or
 * an injection string, so truncating is safe for the verdict. Char-based (an
 * approximate byte bound — JS strings are UTF-16); ample for any honest result.
 */
export const MAX_RESULT_CHARS = 256 * 1024;

function capResultText(s: string): string {
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) : s;
}

/** Flatten an MCP tool result to text we can scan (text content + structured payload). */
export function stringifyResult(result: unknown): string {
  if (!result || typeof result !== "object") return capResultText(String(result ?? ""));
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
  return capResultText(parts.join("\n"));
}

/** Outcome of a bait call: scannable text, or a recorded error/timeout (not silently dropped). */
export type ExerciseOutcome = { ok: true; text: string } | { ok: false; reason: "error" | "timeout" };

/** A tool that won't answer within this bound is recorded as timed-out (not a silent pass). */
export const CALL_TIMEOUT_MS = 15_000;

const TIMEOUT = Symbol("timeout");

/** Call a tool with a bait input; returns its scannable text, or a classified error/timeout. */
export async function exerciseTool(
  client: Client,
  tool: ToolDef,
  bait: string = BAIT_POOL[0]!,
  timeoutMs: number = CALL_TIMEOUT_MS,
): Promise<ExerciseOutcome> {
  try {
    const call = client.callTool({ name: tool.name, arguments: buildBaitArgs(tool.inputSchema, bait) });
    const raced = await Promise.race([
      call,
      new Promise<typeof TIMEOUT>((resolve) => {
        const t = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        t.unref?.();
      }),
    ]);
    if (raced === TIMEOUT) return { ok: false, reason: "timeout" };
    return { ok: true, text: stringifyResult(raced) };
  } catch {
    return { ok: false, reason: "error" };
  }
}
