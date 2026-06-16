/**
 * Env-driven base URL for the polygraph API (mirrors core's CLI). Default is the
 * live site; `POLYGRAPH_API_URL` overrides it (e.g. http://localhost:3000 in dev).
 */

const DEFAULT_BASE = "https://polygraph.so";

export function apiBaseUrl(): string {
  const override = process.env.POLYGRAPH_API_URL;
  if (!override || override.length === 0) return DEFAULT_BASE;
  const trimmed = override.replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`POLYGRAPH_API_URL is not a valid URL: ${override}`);
  }
  // The CLI resolves attestation UIDs through this base; require TLS so a
  // network attacker can't MITM the resolution. Plaintext http is allowed only
  // for a loopback dev server.
  const isLoopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback)) {
    throw new Error(`POLYGRAPH_API_URL must use https (http allowed only for localhost): ${override}`);
  }
  return trimmed;
}

export function attestationsUrl(): string {
  return `${apiBaseUrl()}/api/attestations`;
}
