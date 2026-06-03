/**
 * Deterministic JSON for content-addressing the evidence bundle
 * (onchain-proof-spec §2). Object keys are sorted lexicographically (recursively)
 * so the same bundle always serializes to the same bytes → the same CID. Array
 * order is preserved (the bundle already fixes it: categories by code, probes by
 * ID). Raw string bytes are preserved (hidden-Unicode tampering must change the
 * hash).
 */

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortDeep(src[k]);
    return out;
  }
  return value;
}
