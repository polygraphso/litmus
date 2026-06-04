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

/** Deepest nesting we will canonicalize before rejecting (guards against a
 *  stack overflow on hostile, deeply-nested input). */
const MAX_CANONICAL_DEPTH = 200;

function sortDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new RangeError(`value nesting exceeds ${MAX_CANONICAL_DEPTH} levels`);
  }
  if (Array.isArray(value)) return value.map((v) => sortDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      // defineProperty (not `out[k] = …`) so a key literally named "__proto__"
      // becomes a real own enumerable property that is serialized into the CID,
      // instead of silently hitting the prototype setter and being dropped.
      Object.defineProperty(out, k, {
        value: sortDeep(src[k], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}
