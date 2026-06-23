/**
 * `run_litmus` — run the open behavioral harness end-to-end against an MCP
 * server and return the grade and the evidence. Brand-voiced: plain, exact, no
 * overclaim.
 *
 * Unlike `verify_attestation` (a passive onchain read), this tool LAUNCHES the
 * target server's code to exercise it — sandboxed for egress when Docker is
 * present. It needs no wallet or RPC.
 */

import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { runLitmus, auditDependencies } from "@polygraph/probes";
import { CATEGORY_META, METHODOLOGY_VERSION, type DependencyAudit, type EvidenceBundle } from "@polygraph/core";
import { parseAuthFlags, resolveTarget, checkHostExec, DEFAULT_RUN_TIMEOUT_MS, acquireOAuthToken, isAuthError } from "@polygraph/cli/litmus";

export const RUN_LITMUS_TOOL_NAME = "run_litmus";
export const RUN_LITMUS_TOOL_TITLE = "Run a behavioral litmus on an MCP server";
export const RUN_LITMUS_TOOL_DESCRIPTION = [
  `Grade an MCP server A–F against the open behavioral litmus (${METHODOLOGY_VERSION}).`,
  "The harness connects the way an agent would, fingerprints the tool surface, and",
  "runs four checks: C-01 tool-output injection, C-02 permission/egress overreach",
  "(egress in a hardened default-deny Docker sandbox, plus a declared-permission",
  "honesty check), C-03 sensitive-data handling (planted canaries), and C-04",
  "adversarial-input handling (malformed/oversized and jailbreak inputs).",
  "",
  "This is ACTIVE: it launches the target server's code to exercise it (egress-",
  "sandboxed when Docker is available) and takes ~20–60s. It is not a lookup — for",
  "a server's already-published grade, use `verify_attestation`. No wallet or RPC",
  "needed.",
  "",
  "Each grade also returns a separate `dependencyAudit`: a point-in-time scan of",
  "an npm target's dependency tree against the osv.dev vulnerability database. It is",
  "advisory only — it never affects the A–F grade and is not part of the minted",
  "evidence (non-npm targets report it as skipped).",
  "",
  "server_ref examples: npm/@modelcontextprotocol/server-filesystem ·",
  "https://example.com/mcp · ./build/index.js. For a token-gated https:// target,",
  "pass `bearer`; for an OAuth-gated one, set `interactive_auth: true` to open a",
  "browser and authorize. If Docker is unavailable, C-02 is skipped and the grade is",
  "capped at B for that run.",
].join("\n");

export const runLitmusInputShape = {
  server_ref: z
    .string()
    .min(1)
    .max(512)
    .describe("What to grade: a registry ref (npm/@scope/server), an https:// MCP URL, or a local path to an MCP entry file."),
  bearer: z
    .string()
    .min(1)
    .max(8192)
    .optional()
    .describe("Bearer token for a token-gated https:// MCP server. Sent as `Authorization: Bearer <token>` to the target origin only. Ignored for stdio/local targets."),
  header: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Extra HTTP headers for a gated https:// target, each "Key: Value" (e.g. "X-Api-Key: …"). Overrides the bearer-derived Authorization for the same key. Ignored for stdio/local targets.'),
  unsafe_host_exec: z
    .boolean()
    .optional()
    .describe("Required to grade a registry ref or local path: it launches the target's own code, and without Docker isolation that runs on THIS host. Set true to accept host execution. Ignored for https:// targets or when LITMUS_STDIO_ISOLATION=docker."),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .max(3600)
    .optional()
    .describe("Aggregate wall-clock ceiling for the whole run, in seconds (default 900). Bounds a hostile server that stretches the run across many tools/probes."),
  interactive_auth: z
    .boolean()
    .optional()
    .describe("If a token-gated https:// target uses OAuth, open a browser on THIS machine to authorize and grade with the obtained token (used for this run only, never stored). Default false: without it, an OAuth-gated target returns guidance instead of opening a browser. Ignored for stdio/local targets or when a bearer/header is supplied."),
};

/** Total phases reported via `notifications/progress` (connect + four probes). */
const PROGRESS_TOTAL = 5;

export async function handleRunLitmus(
  { server_ref, bearer, header, unsafe_host_exec, timeout_seconds, interactive_auth }: { server_ref: string; bearer?: string; header?: string[]; unsafe_host_exec?: boolean; timeout_seconds?: number; interactive_auth?: boolean },
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  try {
    // Reuse the CLI's auth parsing so headers are built identically (bearer +
    // "Key: Value" precedence). Pass an EMPTY env on purpose: an operator-set
    // `LITMUS_BEARER` must not silently attach to an MCP call against an
    // arbitrary target the agent chose — only what this call explicitly passed.
    const argv = [
      ...(bearer ? ["--bearer", bearer] : []),
      ...(header ?? []).flatMap((h) => ["--header", h]),
    ];
    const { headers } = parseAuthFlags(argv, {});

    const input = resolveTarget(server_ref);
    // Host-execution safety: a stdio target (registry ref / local path) runs its
    // own code on the host unless Docker isolation is set. Refuse unless the
    // caller explicitly opted in, so the tool isn't silently unsafe-by-default.
    // The MCP server speaks JSON-RPC over a pipe, never a TTY — so this is always
    // non-interactive: the gate returns allow or refuse, never a prompt.
    const decision = checkHostExec(input, {
      optIn: unsafe_host_exec ?? false,
      dockerAvailable: false,
      interactive: false,
      optInHint: 'set "unsafe_host_exec": true',
    });
    if (decision.action === "refuse") {
      return { isError: true as const, content: [{ type: "text" as const, text: `run_litmus refused: ${decision.refuse}` }] };
    }

    // Forward harness phase callbacks as MCP progress, but only if the caller
    // asked for them (sent a progressToken). Best-effort: never block the run.
    const progressToken = extra._meta?.progressToken;
    const sendProgress =
      progressToken !== undefined
        ? (progress: number, message: string): void =>
            void extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress, total: PROGRESS_TOTAL, message },
            })
        : undefined;

    sendProgress?.(0, `Connecting to ${server_ref}…`);
    const runOpts = {
      timeoutMs: timeout_seconds ? timeout_seconds * 1000 : DEFAULT_RUN_TIMEOUT_MS,
      ...(sendProgress ? { onProgress: (done: number, _total: number, label: string) => sendProgress(done, label) } : {}),
    };
    const isHttp = typeof input === "string" && /^https?:\/\//i.test(input);
    const hasExplicitAuth = Object.keys(headers).length > 0;

    let bundle: EvidenceBundle;
    try {
      bundle = await runLitmus(input, { ...(hasExplicitAuth ? { headers } : {}), ...runOpts });
    } catch (err) {
      // A token-gated server that uses OAuth: there's no static token to pass. With
      // interactive_auth, fetch one via the browser (on this machine) and grade with
      // it; otherwise return guidance so the tool never opens a browser unasked.
      if (!(isHttp && !hasExplicitAuth && isAuthError(err))) throw err;
      if (!interactive_auth) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `${server_ref} is token-gated and appears to use OAuth. Re-run with "interactive_auth": true ` +
                "— a browser window will open on this machine to log in — or grade it from the `polygraphso litmus` CLI.",
            },
          ],
        };
      }
      sendProgress?.(0, "Opening your browser to authorize…");
      const token = await acquireOAuthToken(input as string, {
        onAuthUrl: (u) => sendProgress?.(0, `Authorize in your browser: ${u}`),
      });
      if (!token) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `run_litmus failed: could not obtain an OAuth token for ${server_ref} (declined, timed out, or not an OAuth server).` }],
        };
      }
      bundle = await runLitmus(input, { headers: { Authorization: `Bearer ${token}` }, ...runOpts });
    }
    // Advisory dependency audit — a separate, point-in-time osv.dev scan of the
    // npm dependency tree. It never affects the grade and is not part of the
    // evidence bundle; any failure degrades to a "skipped" result.
    let dependencyAudit: DependencyAudit | undefined;
    try {
      dependencyAudit = await auditDependencies(input);
    } catch {
      dependencyAudit = undefined;
    }
    const payload = summarize(bundle, dependencyAudit);
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  } catch (err) {
    // An invalid/oversized/private-resolving target, a hostile (deeply-nested)
    // tool surface, or a connect timeout must surface as a clean tool error —
    // never an unhandled rejection in the host process.
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true as const, content: [{ type: "text" as const, text: `run_litmus failed: ${message}` }] };
  }
}

export function summarize(b: EvidenceBundle, audit?: DependencyAudit) {
  const find = (code: string) => b.categories.find((c) => c.code === code);
  const categories = (["C-01", "C-02", "C-03", "C-04"] as const).map((code) => {
    const c = find(code);
    const findings =
      c?.status === "fail"
        ? c.probes
            .flatMap((p) => p.findings)
            .filter((f) => f.severity === "high")
            .slice(0, 5)
            .map((f) => ({ tool: f.tool, kind: f.kind, match: truncate(f.match, 120), host: f.host, port: f.port }))
        : [];
    return {
      code,
      check: CATEGORY_META[code].label,
      description: CATEGORY_META[code].description,
      status: c?.status ?? "unknown",
      reason: c?.reason ?? null,
      findings,
    };
  });

  // `summary` (the grade rationale) already names why a grade was capped — e.g.
  // for a B: "…Not verified: C-02 (no sandbox (Docker unavailable))." — and the
  // C-02 row repeats its skipped status + reason, so no extra docker note here.
  return {
    grade: b.grade,
    summary: b.gradeRationale,
    serverRef: b.serverRef,
    resolvedVersion: b.resolvedVersion,
    // The server's self-asserted serverInfo.version — descriptive only, not a
    // re-fetchable pin (cf. resolvedVersion). Null when the server reports none.
    selfReportedVersion: b.selfReportedVersion,
    fingerprint: b.toolDefsFingerprint,
    ranAt: b.ranAt,
    methodologyVersion: b.methodologyVersion,
    categories,
    // Advisory only: a point-in-time osv.dev scan of the npm dependency tree.
    // NOT part of the A–F grade and NOT in the minted evidence bundle.
    dependencyAudit: audit
      ? {
          status: audit.status,
          reason: audit.reason ?? null,
          source: audit.source,
          queriedAt: audit.queriedAt,
          dependencyCount: audit.dependencyCount,
          vulnerableCount: audit.vulnerableCount,
          note: "Point-in-time advisory from osv.dev. Not part of the A–F grade or the minted evidence bundle.",
          advisories: audit.advisories.slice(0, 20).map((a) => ({
            package: a.package,
            version: a.version,
            id: a.id,
            severity: a.severity,
            cvss: a.cvss ?? null,
            summary: truncate(a.summary, 160),
            fixedIn: a.fixedIn ?? null,
            url: a.url ?? null,
          })),
        }
      : null,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
