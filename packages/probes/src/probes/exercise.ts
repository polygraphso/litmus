/**
 * Shared helpers for exercising a tool surface: build a minimal bait call from
 * a tool's inputSchema, and flatten an MCP result to scannable text. Used by
 * the dynamic probes (C-01 1.2, C-03 4.1).
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDef } from "@polygraph/core";

/**
 * A VARIED pool of benign-but-suggestive bait strings (litmus-v1 §7: "bait inputs
 * draw from a varied pool, so a static signature match is harder"). It is a FIXED
 * set sent deterministically (no random selection) so the verdict stays
 * reproducible (§6) — the variety, not randomness, is what denies a defeat-device
 * a single string to key off. litmus-v5 widens the pool (4 → 9, spanning lengths,
 * punctuation, whitespace, and mixed scripts) so a server can no longer benign-out
 * by matching the whole pool. None of these contain scanner triggers (no override
 * framing, role tags, `system:`, or markdown URIs), so a clean server echoing them
 * back does not self-incriminate.
 */
export const BAIT_POOL: readonly string[] = [
  "polygraph litmus bait input",
  "summarize the following text for me",
  "please process and echo this content back",
  "here is some material — what do you make of it?",
  "convert the attached note into a short paragraph",
  "the quick brown fox jumps over the lazy dog 12345",
  "first line; then a second line; combine them",
  "   surrounded by extra spaces   ",
  "mixed scripts 日本語 and English together",
  // litmus-v16: more benign variety (emoji/accents, numeric/date punctuation, a
  // longer paragraph) so a defeat-device can't benign-out by matching the whole
  // pool. None contain a scanner trigger, so a clean echo never self-incriminates.
  "café ☕ — a short friendly note with accents and an emoji 🙂",
  "1,024 items · 3.14159 · 2024-01-01T00:00:00Z · 42%",
  "This is a slightly longer paragraph of ordinary prose used to check that a tool handles multi-sentence input. It mentions nothing unusual and asks only that the content be read and returned.",
];

/**
 * Caps that bound probe 1.3 (second-order injection). The per-payload prefix keeps
 * a huge first-order output from ballooning the second call; the sink and total
 * fan-out caps are run-GLOBAL, so 1.3's cost is constant regardless of how many
 * tools a server exposes (it never multiplies out with the surface size).
 */
export const SECOND_ORDER_PAYLOAD_CHARS = 8 * 1024;
export const MAX_SECOND_ORDER_SINKS = 3;
export const MAX_SECOND_ORDER_CALLS = 12;

/**
 * The first required (else first declared) property whose type is "string" (or
 * untyped) — the slot a textual second-order payload can be fed into. Returns
 * null when the tool has no string-shaped input (numeric/boolean/enum-only tools
 * can't carry textual injection, so probe 1.3 skips them).
 */
export function primaryStringInputKey(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as { properties?: Record<string, unknown>; required?: unknown };
  const props = s.properties && typeof s.properties === "object" ? s.properties : {};
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  const ordered = [...required, ...Object.keys(props).filter((k) => !required.includes(k))];
  for (const key of ordered) {
    const p = (props[key] ?? {}) as { type?: unknown; enum?: unknown[] };
    if (Array.isArray(p.enum)) continue; // an enum can't carry arbitrary injection text
    const type = Array.isArray(p.type) ? p.type[0] : p.type;
    if (type === undefined || type === "string") return key;
  }
  return null;
}

/** Param-name shapes that identify a string slot as a URL/remote-content input. */
const URL_NAME_RE = /^(?:url|uri|link|href|src|source|location|endpoint|webpage|web_page|page_url)$/i;
/** Param-name shapes that identify a string slot as a local file/path input. */
const PATH_NAME_RE = /^(?:path|file|file_?path|file_?name|filename|document|doc_?path|local_?path|input_?path|source_?path)$/i;
/** JSON-Schema `format` values that mark a string as a URL. */
const URL_FORMATS = new Set(["uri", "uri-reference", "iri", "iri-reference", "url"]);

/**
 * Classify a tool's primary string input as a CONTENT-FETCH slot — a URL the tool
 * retrieves, or a local file path it reads — so probe 1.4 (indirect/passthrough
 * injection, litmus-v16) can feed harness-controlled external content into exactly
 * the tools that relay third-party data. Detection is by parameter NAME (`url`,
 * `path`, `file`, …) or JSON-Schema `format` (`uri`). Returns the slot key + kind,
 * or null when no string param looks like a content-fetch input. Mirrors
 * {@link primaryStringInputKey}'s required-first ordering.
 */
export function contentFetchInputKey(schema: unknown): { key: string; kind: "url" | "path" } | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as { properties?: Record<string, unknown>; required?: unknown };
  const props = s.properties && typeof s.properties === "object" ? s.properties : {};
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  const ordered = [...required, ...Object.keys(props).filter((k) => !required.includes(k))];
  for (const key of ordered) {
    const p = (props[key] ?? {}) as { type?: unknown; enum?: unknown[]; format?: unknown };
    if (Array.isArray(p.enum)) continue;
    const type = Array.isArray(p.type) ? p.type[0] : p.type;
    if (type !== undefined && type !== "string") continue;
    const format = typeof p.format === "string" ? p.format.toLowerCase() : "";
    if (URL_FORMATS.has(format) || URL_NAME_RE.test(key)) return { key, kind: "url" };
    if (PATH_NAME_RE.test(key)) return { key, kind: "path" };
  }
  return null;
}

/** Build args feeding `payload` into the tool's primary string slot (other
 *  required fields defaulted via {@link buildBaitArgs}). Null when there is no
 *  string slot to carry the payload. */
export function buildSecondOrderArgs(schema: unknown, payload: string): Record<string, unknown> | null {
  const key = primaryStringInputKey(schema);
  if (key === null) return null;
  return { ...buildBaitArgs(schema), [key]: payload };
}

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

/** Outcome of a bait call: scannable text, or a recorded error/timeout (not silently dropped).
 *  errorText carries the JSON-RPC error message for "error" outcomes so scanners can inspect
 *  injection/internals-leak content returned via the error channel. */
export type ExerciseOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "error"; errorText: string };

/** A tool that won't answer within this bound is recorded as timed-out (not a silent pass). */
export const CALL_TIMEOUT_MS = 15_000;

const TIMEOUT = Symbol("timeout");

/** Race a promise against a bounded timeout, resolving to the {@link TIMEOUT}
 *  sentinel rather than hanging. Shared by the call and liveness helpers. */
function raceTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT> {
  return Promise.race([
    p,
    new Promise<typeof TIMEOUT>((resolve) => {
      const t = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      t.unref?.();
    }),
  ]);
}

/**
 * Call a tool with explicit arguments; returns its scannable text, or a
 * classified error/timeout. The args-based form is the C-04 path (adversarial,
 * not schema-derived) and the shared core of {@link exerciseTool}.
 */
export async function callToolArgs(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number = CALL_TIMEOUT_MS,
): Promise<ExerciseOutcome> {
  try {
    const raced = await raceTimeout(client.callTool({ name, arguments: args }), timeoutMs);
    if (raced === TIMEOUT) return { ok: false, reason: "timeout" };
    return { ok: true, text: stringifyResult(raced) };
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "error", errorText };
  }
}

/** Call a tool with a bait input; returns its scannable text, or a classified error/timeout. */
export async function exerciseTool(
  client: Client,
  tool: ToolDef,
  bait: string = BAIT_POOL[0]!,
  timeoutMs: number = CALL_TIMEOUT_MS,
): Promise<ExerciseOutcome> {
  return callToolArgs(client, tool.name, buildBaitArgs(tool.inputSchema, bait), timeoutMs);
}

/**
 * A cheap round-trip telling whether the server is still answering. C-04 probe
 * 3.1 uses it to distinguish a graceful per-call rejection (server alive after a
 * malformed input — a PASS) from a crash/hang the input induced (server dead — a
 * FAIL). `listTools` is a read-only protocol call with no side effects.
 */
export async function serverResponsive(client: Client, timeoutMs = 4_000): Promise<boolean> {
  try {
    return (await raceTimeout(client.listTools(), timeoutMs)) !== TIMEOUT;
  } catch {
    return false;
  }
}
