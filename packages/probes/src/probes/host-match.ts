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

// ── Port-aware matching (litmus-v5) ──────────────────────────────────────────
// An allowlist pattern may pin a port (`api.example.com:443`); a host-only pattern
// (`api.example.com`) means "any port" — backward-compatible with pre-v5
// declarations. So a declared host reached on an UNDECLARED port is overreach,
// while every existing host-only declaration behaves exactly as before.

export interface HostPortPattern {
  host: string;
  /** null = match any port (host-only pattern). */
  port: number | null;
}

/** Parse a pattern into {host, port}. A trailing `:<1-65535>` is a port
 *  constraint; anything else (no colon, non-numeric or out-of-range tail) is
 *  host-only. Fails OPEN on a doubtful parse — never invents a port. */
export function parseHostPortPattern(pattern: string): HostPortPattern {
  const p = pattern.trim().toLowerCase();
  const colon = p.lastIndexOf(":");
  if (colon > 0 && colon < p.length - 1) {
    const tail = p.slice(colon + 1);
    if (/^\d+$/.test(tail)) {
      const port = Number(tail);
      if (port >= 1 && port <= 65535) return { host: p.slice(0, colon), port };
    }
  }
  return { host: p, port: null };
}

/** True iff `host` matches the pattern's host AND (the pattern pins no port, or
 *  `observedPort` equals it). An unknown observed port matches only a host-only
 *  pattern — a port-pinned pattern is never granted to an unseen port
 *  (safe-by-construction: matching can only get stricter, never looser). */
export function hostPortMatches(host: string, observedPort: number | undefined, pattern: string): boolean {
  const { host: hp, port: pp } = parseHostPortPattern(pattern);
  if (!hostMatchesPattern(host, hp)) return false;
  if (pp === null) return true;
  return observedPort !== undefined && observedPort === pp;
}
