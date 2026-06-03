/**
 * Env-driven base URL for the polygraph API (mirrors core's CLI). Default is the
 * live site; `POLYGRAPH_API_URL` overrides it (e.g. http://localhost:3000 in dev).
 */

const DEFAULT_BASE = "https://polygraph.so";

export function apiBaseUrl(): string {
  const override = process.env.POLYGRAPH_API_URL;
  if (!override || override.length === 0) return DEFAULT_BASE;
  return override.replace(/\/+$/, "");
}

export function pinUrl(): string {
  return `${apiBaseUrl()}/api/pin`;
}

export function attestationsUrl(): string {
  return `${apiBaseUrl()}/api/attestations`;
}

/** The web mint deep-link the CLI hands off to (`/mint?cid&ref&fp`). */
export function mintUrl(params: { cid: string; ref: string; fp: string }): string {
  const u = new URL(`${apiBaseUrl()}/mint`);
  u.searchParams.set("cid", params.cid);
  u.searchParams.set("ref", params.ref);
  u.searchParams.set("fp", params.fp);
  return u.toString();
}
