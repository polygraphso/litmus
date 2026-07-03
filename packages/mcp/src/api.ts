/**
 * HTTP client for polygraph.so's published-grade lookup API — the backend for
 * the `check_server` / `list_servers` / `request_grade` tools.
 *
 * These endpoints serve PRECOMPUTED published grades (the same data the site
 * shows), distinct from the onchain attestation read that `verify_attestation`
 * does. Anonymous; no keys. `POLYGRAPH_API_URL` overrides the base for a local
 * dev server — https is required except for loopback, matching the CLI's rule,
 * so a network attacker can't MITM a grade lookup.
 *
 * Endpoints:
 *   POST /api/cli/check          → { server_ref } → graded | not_available
 *   GET  /api/cli/list           → { servers, total }
 *   POST /api/cli/grade-request  → { server_ref, source, agent_id? } → queued
 *
 * Failures throw `PolygraphApiError` with a stable `kind` so tool handlers can
 * map them to clean MCP error results rather than transport crashes.
 */

const DEFAULT_BASE = "https://polygraph.so";

export type ApiErrorKind = "network" | "http" | "malformed";

export class PolygraphApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "PolygraphApiError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export function lookupApiBaseUrl(): string {
  const override = process.env.POLYGRAPH_API_URL;
  if (!override || override.length === 0) return DEFAULT_BASE;
  const trimmed = override.replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`POLYGRAPH_API_URL is not a valid URL: ${override}`);
  }
  const isLoopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback)) {
    throw new Error(`POLYGRAPH_API_URL must use https (http allowed only for localhost): ${override}`);
  }
  return trimmed;
}

export interface CheckResponseGraded {
  status: "graded";
  // The published grade; polygraph_detail carries the per-check results,
  // fingerprint, and methodology version, passed through verbatim.
  polygraph: "A" | "B" | "C" | "D" | "F";
  polygraph_detail?: unknown;
  notify_url: string;
  current_version?: string | null;
  version_match?: boolean | null;
}

export interface CheckResponseNotAvailable {
  status: "not_available";
  notify_url: string;
  // Present on current servers; optional so an older deployment still parses.
  message?: string;
  self_grade?: string;
}

export type CheckResponse = CheckResponseGraded | CheckResponseNotAvailable;

export interface ListEntry {
  server_ref: string;
  polygraph: "A" | "B" | "C" | "D" | "F";
}

export interface ListResponse {
  servers: ListEntry[];
  total: number;
}

export interface GradeRequestResponse {
  status: "queued";
  // false when this target was already queued (idempotent re-request).
  created: boolean;
  // How many requests stand behind this target — the demand signal.
  demand: number;
}

async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new PolygraphApiError("malformed", "polygraph.so returned a non-JSON response.");
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${lookupApiBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolygraphApiError("network", `couldn't reach polygraph.so (${msg}).`);
  }

  // 400 = the ref was rejected; propagate the server's message so the agent
  // can see why and retry with a correct ref.
  if (res.status === 400) {
    let body: { error?: string };
    try {
      body = (await res.json()) as { error?: string };
    } catch {
      body = {};
    }
    throw new PolygraphApiError(
      "http",
      body.error ?? "polygraph.so rejected the request as malformed.",
      400,
    );
  }

  if (!res.ok) {
    throw new PolygraphApiError("http", `polygraph.so returned ${res.status}.`, res.status);
  }

  return readJson<T>(res);
}

export async function postCheck(serverRef: string): Promise<CheckResponse> {
  return request<CheckResponse>("/api/cli/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server_ref: serverRef }),
  });
}

export async function getList(): Promise<ListResponse> {
  return request<ListResponse>("/api/cli/list", { method: "GET" });
}

export async function postGradeRequest(
  serverRef: string,
  agentId?: string,
): Promise<GradeRequestResponse> {
  const body: { server_ref: string; source: "mcp"; agent_id?: string } = {
    server_ref: serverRef,
    source: "mcp",
  };
  if (agentId) body.agent_id = agentId;
  return request<GradeRequestResponse>("/api/cli/grade-request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
