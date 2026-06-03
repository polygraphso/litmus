/**
 * C-01 — Tool-output injection (litmus-test-v1 §C-01).
 *
 * Probe 1.1 (static): scan every tool name / description / inputSchema for
 * injection-shaped content. No tool calls; deterministic.
 *
 * Probe 1.2 (dynamic): issue benign bait calls to each tool and scan the
 * outputs for injection-shaped echoes. Best-effort — a call that errors (schema
 * mismatch, auth, etc.) leaves that tool unexercised, not failed.
 *
 * Fail on any HIGH-severity scanner hit in either probe.
 */

import type { CategoryResult, Finding, ProbeResult } from "@polygraph/core";
import type { ProbeContext } from "./context.js";
import {
  hasHighSeverity,
  instructionMimicry,
  invisibleUnicode,
  markdownTricks,
} from "./scanners.js";

function scanText(text: string, tool: string): Finding[] {
  return [
    ...invisibleUnicode(text),
    ...instructionMimicry(text),
    ...markdownTricks(text),
  ].map((f) => ({ ...f, tool }));
}

/** Probe 1.1 — static scan of the advertised tool surface. */
function probe11(ctx: ProbeContext): ProbeResult {
  const findings: Finding[] = [];
  for (const t of ctx.tools) {
    const surface = `${t.name}\n${t.description}\n${JSON.stringify(t.inputSchema ?? {})}`;
    findings.push(...scanText(surface, t.name));
  }
  return { id: "1.1", status: hasHighSeverity(findings) ? "fail" : "pass", findings };
}

/** Probe 1.2 — dynamic scan of bait-call outputs. */
async function probe12(ctx: ProbeContext): Promise<ProbeResult> {
  const findings: Finding[] = [];
  let exercised = 0;
  for (const t of ctx.tools) {
    let result: unknown;
    try {
      result = await ctx.client.callTool({ name: t.name, arguments: buildBaitArgs(t.inputSchema) });
    } catch {
      continue; // unexercised — not a failure
    }
    exercised++;
    findings.push(...scanText(stringifyResult(result), t.name));
  }
  const reason = exercised === 0 ? "no tools could be exercised with bait inputs" : null;
  return { id: "1.2", status: hasHighSeverity(findings) ? "fail" : "pass", findings, reason };
}

export async function c01Injection(ctx: ProbeContext): Promise<CategoryResult> {
  const p11 = probe11(ctx);
  const p12 = await probe12(ctx);
  const probes = [p11, p12];
  const status = probes.some((p) => p.status === "fail") ? "fail" : "pass";
  return { code: "C-01", status, probes };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const BAIT_STRING = "polygraph litmus bait input";

/** Build minimal arguments from a JSON-schema-ish inputSchema for a bait call. */
function buildBaitArgs(schema: unknown): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (!schema || typeof schema !== "object") return args;
  const s = schema as { properties?: Record<string, unknown>; required?: unknown };
  const props = s.properties && typeof s.properties === "object" ? s.properties : {};
  const required = Array.isArray(s.required) ? (s.required as string[]) : Object.keys(props);
  for (const key of required) {
    args[key] = baitValue(props[key]);
  }
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

/** Flatten an MCP tool result to text we can scan (covers text + structured content). */
function stringifyResult(result: unknown): string {
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
  // also include the whole structured payload, so injection in non-text fields is caught
  try {
    parts.push(JSON.stringify(result));
  } catch {
    /* circular — ignore */
  }
  return parts.join("\n");
}
