/**
 * Host-pattern matching for the C-02 egress allowlist (litmus-v3).
 *
 * Patterns are exact hosts (`api.openai.com`) or single-label-or-more wildcards
 * (`*.example.com`, matching any subdomain but NOT the apex). Matching is
 * case-insensitive and operates on label boundaries — the pattern's dots are
 * literal, never compiled to a RegExp (operator/declaration input is untrusted).
 */

/** Lowercase, trim, strip a trailing dot and any `:port` suffix. */
export function normalizeHost(h: string): string {
  let s = h.trim().toLowerCase();
  const colon = s.indexOf(":");
  if (colon !== -1) s = s.slice(0, colon);
  if (s.endsWith(".")) s = s.slice(0, -1);
  return s;
}

export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = pattern.trim().toLowerCase();
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com" — leading dot enforces a label boundary
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => hostMatchesPattern(host, p));
}
