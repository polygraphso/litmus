/**
 * The C-02 egress allowlist (litmus-v3). The effective allowlist a server is held
 * to is the union of an operator BASELINE (universally-benign hosts, off by
 * default) and the server's own DECLARATION (`polygraph.egress` in package.json).
 * Egress beyond that union is overreach.
 */

import { normalizeHost } from "./host-match.js";

/** Operator baseline, defaulting to EMPTY so a non-declaring server behaves
 *  exactly as it did pre-v3 (every egress is overreach → C-02 fail). A non-empty
 *  default would silently turn old failing grades into passes, so it must be an
 *  explicit operator choice via LITMUS_EGRESS_ALLOWLIST. */
export const DEFAULT_EGRESS_BASELINE: readonly string[] = [];

/** Normalize a pattern: trim + lowercase, preserving a `*.` wildcard. */
function normalizePattern(p: string): string {
  return p.trim().toLowerCase();
}

/** Parse `LITMUS_EGRESS_ALLOWLIST` (comma-separated host patterns). */
export function parseAllowlistEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(normalizePattern)
    .filter((s) => s.length > 0);
}

/** Union the baseline and the server's declaration, deduped case-insensitively. */
export function effectiveAllowlist(baseline: readonly string[], declared: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...baseline, ...declared]) {
    const n = normalizePattern(p);
    if (n.length > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** Normalize a server's declared-egress list (drops blanks; keeps verbatim host
 *  patterns the author wrote, lowercased). Hosts are matched via host-match. */
export function normalizeDeclared(declared: readonly string[]): string[] {
  return declared.map(normalizePattern).filter((s) => s.length > 0);
}

// re-export for callers that classify observed hosts against the list
export { normalizeHost };
