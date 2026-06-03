/**
 * Tool-surface fingerprint (litmus-test-v1 §6, technical-design §3).
 *
 * Canonicalize the tool surface from `tools/list` and hash it to a bytes32:
 *   - keep {name, description, inputSchema} per tool
 *   - sort tools by name; recursively sort object keys
 *   - normalize ASCII whitespace in descriptions (trim/collapse) but KEEP raw
 *     Unicode — hidden-character injection must change the hash
 *   - JSON.stringify → sha256 → `0x` + 64 hex
 *
 * The grade certifies *this exact surface*; the consuming agent recomputes the
 * live fingerprint before paying and refuses on any mismatch (rug-pull guard).
 */

import { createHash } from "node:crypto";
import type { ToolDef } from "@polygraph/core";

export interface FingerprintResult {
  /** `0x` + 64 lowercase hex (bytes32). */
  fingerprint: string;
  /** The canonicalized tool defs that were hashed (also stored in the bundle). */
  canonical: ToolDef[];
}

export function fingerprintToolDefs(tools: readonly ToolDef[]): FingerprintResult {
  const canonical: ToolDef[] = tools
    .map((t) => ({
      name: t.name,
      description: normalizeWhitespace(t.description ?? ""),
      inputSchema: sortKeysDeep(t.inputSchema ?? null),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const json = JSON.stringify(canonical);
  const hash = createHash("sha256").update(json, "utf8").digest("hex");
  return { fingerprint: "0x" + hash, canonical };
}

/** Collapse runs of ASCII whitespace and trim; leaves all other code points intact. */
function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t\r\n\f\v]+/g, " ").trim();
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return value;
}
