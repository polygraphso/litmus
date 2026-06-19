/**
 * Reuse a credential the user already configured. When grading a token-gated
 * https:// MCP server, the bearer token usually already exists on the machine —
 * in the same MCP client config that makes the server work in the user's agent.
 * This resolver finds the entry whose URL matches the target and returns its
 * headers, so the CLI can reuse them (after confirmation) instead of asking the
 * user to paste a token.
 *
 * Read-only and best-effort: it only reads config files, never writes, and any
 * miss falls back to the existing prompt. It lives at the CLI layer and is
 * invoked explicitly — never inside the harness — so a hosted runner never reads
 * local disk.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export interface DiscoveredAuth {
  /** Headers to send to the target (e.g. `{ Authorization: "Bearer …" }`). */
  headers: Record<string, string>;
  /** The config file the credential came from (named in the consent prompt). */
  source: string;
}

/** Normalize a URL for matching: lowercase origin, drop a trailing path slash. */
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return u;
  }
}

/** Expand `${VAR}` / `${env:VAR}` from the environment; unknown collapses to "". */
export function resolveEnvPlaceholders(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "");
}

type ServerEntry = { url?: unknown; headers?: unknown };

/** Pull every `{name: {url, headers}}` entry out of a parsed config, across the
 *  shapes MCP clients use: top-level `mcpServers`/`servers`, and per-project
 *  `projects.<path>.mcpServers` (Claude Code's ~/.claude.json). */
function collectServerEntries(config: unknown): ServerEntry[] {
  const out: ServerEntry[] = [];
  if (!config || typeof config !== "object") return out;
  const c = config as Record<string, unknown>;
  for (const key of ["mcpServers", "servers"]) {
    const map = c[key];
    if (map && typeof map === "object") out.push(...Object.values(map as Record<string, ServerEntry>));
  }
  const projects = c.projects;
  if (projects && typeof projects === "object") {
    for (const proj of Object.values(projects as Record<string, unknown>)) out.push(...collectServerEntries(proj));
  }
  return out;
}

/** Find headers for a target URL in one already-parsed config object. Pure. */
export function extractMatchingHeaders(
  config: unknown,
  targetUrl: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> | null {
  const target = normalizeUrl(targetUrl);
  for (const entry of collectServerEntries(config)) {
    if (typeof entry.url !== "string" || normalizeUrl(entry.url) !== target) continue;
    if (!entry.headers || typeof entry.headers !== "object") continue;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = resolveEnvPlaceholders(v, env);
    }
    if (Object.keys(headers).length > 0) return headers;
  }
  return null;
}

/** Candidate config files, project-local first (more specific wins). */
export function candidateConfigPaths(cwd: string, home: string): string[] {
  return [
    path.join(cwd, ".mcp.json"),
    path.join(cwd, ".cursor", "mcp.json"),
    path.join(cwd, ".vscode", "mcp.json"),
    path.join(home, ".claude.json"),
    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    path.join(home, ".cursor", "mcp.json"),
  ];
}

export interface ResolveOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable reader (tests): file contents, or null if absent/unreadable. */
  readFile?: (p: string) => string | null;
}

/** Find a configured credential for `targetUrl`, project-local before user-global. */
export function resolveHeadersFromClientConfig(targetUrl: string, opts: ResolveOptions = {}): DiscoveredAuth | null {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const read = opts.readFile ?? ((p: string) => (existsSync(p) ? safeRead(p) : null));

  for (const file of candidateConfigPaths(cwd, home)) {
    const raw = read(file);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // a malformed config is skipped, not fatal
    }
    const headers = extractMatchingHeaders(parsed, targetUrl, env);
    if (headers) return { headers, source: file };
  }
  return null;
}

/** Best-effort: does this connect error look like the server rejecting us for
 *  lack of (valid) auth? Broad by design — a miss only means we don't offer to
 *  reuse a configured token and fall back to the existing error. */
export function isAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /\b40[13]\b/.test(msg) ||
    msg.includes("unauthor") ||
    msg.includes("forbidden") ||
    msg.includes("invalid_token") ||
    msg.includes("invalid token") ||
    msg.includes("www-authenticate") ||
    msg.includes("no authorization")
  );
}

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
