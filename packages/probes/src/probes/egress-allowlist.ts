/**
 * The C-02 egress allowlist (litmus-v3). The effective allowlist a server is held
 * to is the union of an operator BASELINE (universally-benign hosts, off by
 * default) and the server's own DECLARATION (`polygraph.egress` in package.json).
 * Egress beyond that union is overreach.
 */

import { normalizeHost } from "./host-match.js";

/**
 * Public package-registry infrastructure (litmus-v15). Reaching one of these is
 * not the SERVER's egress — it is the language/framework tooling underneath it.
 * The dominant case: FastMCP's stdio `run()` prints a startup banner that calls
 * `check_for_newer_version()` → GET https://pypi.org/pypi/fastmcp/json (on by
 * default, cold cache in the sandbox). Every FastMCP-based server therefore
 * "reaches pypi.org" with zero author intent; pip/npm metadata checks are the
 * same shape. These hosts are server-independent benign infrastructure, so they
 * belong on the baseline rather than being scored as the server's overreach.
 *
 * Deliberately NARROW — registry APIs + their download CDNs only. It does NOT
 * include the cloud instance-metadata endpoint (169.254.169.254 /
 * metadata.google.internal): a cloud SDK probing it for credentials is the same
 * *class* of framework noise, but the metadata endpoint is a real SSRF /
 * credential-theft target, so allowlisting it would blind C-02 to genuine abuse.
 * That case is left flagged (better handled by phase-scoped egress, not an
 * allowlist).
 */
export const PACKAGE_REGISTRY_BASELINE: readonly string[] = [
  "pypi.org", // PyPI metadata/JSON API — FastMCP + pip update checks
  "files.pythonhosted.org", // PyPI package-download CDN
  "registry.npmjs.org", // npm metadata / update checks
];

/** Operator baseline: universally-benign, server-independent hosts. Was EMPTY
 *  before litmus-v15; now seeded with package-registry infrastructure (above)
 *  so ubiquitous framework/tooling update-checks are not scored as the server's
 *  egress overreach. Extended per-run via LITMUS_EGRESS_ALLOWLIST. */
export const DEFAULT_EGRESS_BASELINE: readonly string[] = [...PACKAGE_REGISTRY_BASELINE];

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
