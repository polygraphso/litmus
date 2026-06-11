/**
 * Same-origin guard for caller-supplied auth headers (e.g. a bearer token sent
 * to an OAuth-gated MCP server). Wraps `fetch` so those headers reach ONLY the
 * target origin; if the transport ever issues a request to another origin, the
 * auth headers are stripped first, so a token can't leak to a third party.
 *
 * Residual limitation: the platform `fetch` follows HTTP 3xx redirects
 * transparently and re-sends headers itself, so a target that redirects
 * cross-origin can still receive the token. We accept that for v1 — the token
 * is already entrusted to the target, and the SSRF guard blocks redirects to
 * private addresses — and disclose it; the full fix is manual redirect handling.
 */

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export function sameOriginAuthFetch(target: string, authHeaders: Record<string, string>): FetchLike {
  const targetOrigin = new URL(target).origin;
  const authKeys = Object.keys(authHeaders).map((k) => k.toLowerCase());
  return (url, init) => {
    const reqOrigin = new URL(typeof url === "string" ? url : url.toString()).origin;
    if (reqOrigin === targetOrigin) return fetch(url, init);
    const headers = new Headers(init?.headers);
    for (const k of authKeys) headers.delete(k);
    return fetch(url, { ...init, headers });
  };
}
