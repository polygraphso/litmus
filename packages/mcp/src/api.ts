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
 * Endpoints (all carry the caller's identity when the client announced one —
 * `source: "mcp"` + `agent_id` + `agent_meta` — feeding polygraph.so's
 * aggregate per-agent usage counters; software metadata only):
 *   POST /api/cli/check          → { server_ref, … } → graded | not_available
 *   GET  /api/cli/list?…         → { servers, total, summary? }
 *   POST /api/cli/grade-request  → { server_ref, … } → queued
 *
 * Failures throw `PolygraphApiError` with a stable `kind` so tool handlers can
 * map them to clean MCP error results rather than transport crashes.
 */

import type { LitmusGrade } from "@polygraph/core";
import type { ClientAgent } from "./client-id.js";

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
  // Trim trailing slashes without a regex — a backtracking `/\/+$/` is
  // polynomial on many-slash input (CodeQL js/polynomial-redos).
  let end = override.length;
  while (end > 0 && override.charCodeAt(end - 1) === 47 /* '/' */) end--;
  const trimmed = override.slice(0, end);
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

/** Optional aggregate the API may attach: total count plus a per-grade
 *  breakdown for the query as filtered (not just the page returned). Shape is
 *  additive and not guaranteed on every deployment, so every field is optional. */
export interface ListSummary {
  total?: number;
  counts?: Partial<Record<LitmusGrade, number>>;
}

export interface ListResponse {
  servers: ListEntry[];
  total: number;
  summary?: ListSummary;
}

export interface ListParams {
  /** Filter to a single letter grade. */
  grade?: LitmusGrade;
  /** Max rows to return. */
  limit?: number;
  /** Rows to skip, for paging past `limit`. */
  offset?: number;
}

/**
 * How grading is paid for. polygraph charges a small one-time fee per request
 * (it buys the run, never the grade); grading starts once the fee is paid and
 * the grade publishes within 48h of payment. `required: false` = already paid.
 */
export interface GradeRequestPaymentInfo {
  required: boolean;
  usdPrice: number;
  /** The web checkout for this request. */
  payUrl: string | null;
  /** x402 endpoint — POST the same request with an X-PAYMENT header (USDC on Base). */
  x402Url: string;
}

export interface GradeRequestResponse {
  status: "queued";
  // false when this target was already recorded (idempotent re-request).
  created: boolean;
  // How many requests stand behind this target — the demand signal.
  demand: number;
  // Present since the grading fee shipped; absent from older deployments.
  requestId?: string | null;
  payment?: GradeRequestPaymentInfo;
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

function identityFields(agent?: ClientAgent): {
  source: "mcp";
  agent_id?: string;
  agent_meta?: ClientAgent["meta"];
} {
  const out: { source: "mcp"; agent_id?: string; agent_meta?: ClientAgent["meta"] } = {
    source: "mcp",
  };
  if (agent?.agentId) out.agent_id = agent.agentId;
  if (agent?.meta) out.agent_meta = agent.meta;
  return out;
}

export async function postCheck(serverRef: string, agent?: ClientAgent): Promise<CheckResponse> {
  return request<CheckResponse>("/api/cli/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server_ref: serverRef, ...identityFields(agent) }),
  });
}

// `params` comes first, `agent` second. TypeScript currently rejects passing
// just an agent here (`getList(agentVar)`) because `ClientAgent` and
// `ListParams` share no field names, but that protection is incidental to
// today's field names, not a real type constraint: if the two interfaces
// ever gain an overlapping property, the mistake would compile silently.
// Always pass the params object explicitly, even `{}`, before the agent.
export async function getList(params: ListParams = {}, agent?: ClientAgent): Promise<ListResponse> {
  const search = new URLSearchParams({ source: "mcp" });
  if (agent?.agentId) search.set("agent_id", agent.agentId);
  if (params.grade) search.set("grade", params.grade);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  return request<ListResponse>(`/api/cli/list?${search.toString()}`, { method: "GET" });
}

export async function postGradeRequest(
  serverRef: string,
  agent?: ClientAgent,
): Promise<GradeRequestResponse> {
  return request<GradeRequestResponse>("/api/cli/grade-request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server_ref: serverRef, ...identityFields(agent) }),
  });
}
