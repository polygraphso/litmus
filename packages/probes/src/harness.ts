/**
 * The harness orchestrator (technical-design §3): connect → fingerprint →
 * probes → grade → bundle. Public entry point: `runLitmus`.
 */

import { execFile } from "node:child_process";
import type { EvidenceBundle, ToolDef } from "@polygraph/core";
import { connectTarget, type TargetInput } from "./connect/index.js";
import { fingerprintToolDefs } from "./fingerprint.js";
import { c01Injection } from "./probes/c01-injection.js";
import { c02Permission, probe21Declaration } from "./probes/c02-egress.js";
import { c03Sensitive } from "./probes/c03-sensitive.js";
import { c04Adversarial } from "./probes/c04-adversarial.js";
import { canaryEnv, mintCanaries, seedCanaryDir } from "./probes/canaries.js";
import { runEgressProbe, type EgressResult } from "./docker/egress-runner.js";
import { parseAllowlistEnv, DEFAULT_EGRESS_BASELINE } from "./probes/egress-allowlist.js";
import type { ProbeContext } from "./probes/context.js";
import { stateChangingToolNames, type ToolAnnotations, type ToolSafetyInput } from "./probes/tool-safety.js";
import { gradeFromCategories } from "./grade.js";
import { assembleBundle } from "./bundle.js";

export type { TargetInput } from "./connect/index.js";

/** Caller-supplied knobs for a litmus run. */
export interface RunLitmusOptions {
  /**
   * HTTP request headers for a remote (`https://`) target — e.g. an
   * `Authorization: Bearer …` to grade an OAuth-gated MCP server. Ignored for
   * stdio targets.
   */
  headers?: Record<string, string>;
  /**
   * Actively call state-changing tools (`send`/`swap`/`sign`/`delete` …) too.
   * Off by default: those tools are skipped from bait calls so the harness
   * can't move money or mutate state on an authenticated server.
   */
  allowStateChanging?: boolean;
  /**
   * stdio execution mode. "docker" runs an npm target ONLY inside the hardened
   * container and fails the run on any isolation failure (no fallback to host
   * exec, no B-cap). Default: "docker" when `LITMUS_STDIO_ISOLATION=docker`,
   * else "none".
   */
  isolation?: "none" | "docker";
  /** Override the baked bundle disclaimer (e.g. the hosted operator-run string). */
  disclaimer?: string;
  /** Label every docker resource created by this run, so a killed parent can sweep. */
  runLabel?: string;
  /**
   * Overall wall-clock ceiling (ms) for the whole probe sequence after connect.
   * The per-step timeouts (connect, listTools, each tool call) bound individual
   * calls, but their SUM is attacker-controlled: a hostile server can declare up
   * to MAX_TOOLS tools and hang each call to its per-call timeout. This caps the
   * aggregate so the in-process (`https`) path can't pin the caller for hours.
   * Unset ⇒ no aggregate bound (the npm path is already bounded by the scrubbed
   * child's process-group SIGKILL in executeRun). On timeout the run rejects and
   * the `finally` tears the connection down, settling any in-flight calls.
   */
  timeoutMs?: number;
  /**
   * Optional progress callback, fired once per probe phase as the run proceeds:
   * `(done, total, label)` are step counts plus a short human phase name. Purely
   * observational — it never affects the grade or the bundle. The MCP server
   * forwards these as `notifications/progress` so a ~20–60s run isn't a frozen
   * tool call.
   */
  onProgress?: (done: number, total: number, label: string) => void;
}

/** Phase count reported through {@link RunLitmusOptions.onProgress}. */
const PROGRESS_STEPS = 5;

export async function runLitmus(target: TargetInput, opts: RunLitmusOptions = {}): Promise<EvidenceBundle> {
  const isolation: "none" | "docker" =
    opts.isolation ?? (process.env.LITMUS_STDIO_ISOLATION === "docker" ? "docker" : "none");
  const ranAt = new Date().toISOString();
  // C-02 (litmus-v3) operator baseline egress allowlist: DEFAULT (empty) ∪ env.
  const baselineAllowlist = [...DEFAULT_EGRESS_BASELINE, ...parseAllowlistEnv(process.env.LITMUS_EGRESS_ALLOWLIST)];
  const dockerAvailable = await isDockerAvailable();
  const canaries = mintCanaries();
  const seedEnv = canaryEnv(canaries);

  const isHttp = typeof target === "string" && /^https?:\/\//i.test(target);
  const isStdio = !isHttp;

  // Under isolation, the runner executes attacker-chosen packages: fail closed.
  // Docker is a hard requirement for a stdio target — refuse rather than fall
  // back to running the target on the host.
  if (isolation === "docker" && isStdio && !dockerAvailable) {
    throw new Error("stdio isolation requires Docker — refusing to run the target on the host");
  }

  // Seed canaries into a throwaway working directory too (not just env), so a
  // file/secret-reading tool surfaces them (litmus-v1 §C-03). Local stdio only —
  // a remote HTTP server's cwd/env can't be seeded.
  const seed = isHttp ? null : seedCanaryDir(canaries);
  const conn = await connectTarget(target, {
    seedEnv,
    seedCwd: seed?.dir,
    httpHeaders: opts.headers,
    isolation,
    ...(opts.runLabel ? { runLabel: opts.runLabel } : {}),
  });

  try {
    // The whole probe sequence is optionally bounded by opts.timeoutMs so the
    // sum of per-call timeouts (MAX_TOOLS × per-call) can't run for hours. The
    // outer `finally` tears the connection down on timeout, which settles any
    // in-flight call against the (now-closed) transport.
    const runProbes = async (): Promise<EvidenceBundle> => {
      const step = (done: number, label: string): void => opts.onProgress?.(done, PROGRESS_STEPS, label);
      // Enumerate the FULL tool surface across pagination — a hidden page-2 tool
      // would otherwise dodge both the grade and the rug-pull fingerprint.
      const listed = await enumerateTools(conn.client);
      const tools: ToolDef[] = listed.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? null,
      }));
      assertGradableSurface(tools);

      const { fingerprint, canonical } = fingerprintToolDefs(tools);
      step(1, "fingerprinted tool surface");
      // Classify from the RAW list (annotations are dropped from ToolDef — they
      // must never enter the fingerprint hash) to decide which tools are unsafe
      // to actively call (state-changing) and to run probe 2.1 (declared-
      // permission honesty). The static scan still covers all of them.
      const annotated: ToolSafetyInput[] = listed.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? null,
        annotations: t.annotations as ToolAnnotations | undefined,
      }));
      const stateChangingTools = stateChangingToolNames(annotated);
      const ctx: ProbeContext = {
        client: conn.client,
        tools,
        canaries: canaries.all,
        dockerAvailable,
        stateChangingTools,
        allowStateChanging: opts.allowStateChanging ?? false,
      };

      const egress: EgressResult =
        dockerAvailable && typeof target === "string" && !/^https?:\/\//i.test(target)
          ? await runEgressProbe(target, { canaryEnv: seedEnv, baselineAllowlist, ...(opts.runLabel ? { runLabel: opts.runLabel } : {}) })
          : {
              ran: false,
              reason: dockerAvailable ? "egress not run for this target" : "no sandbox (Docker unavailable)",
              attempts: [],
              declaredEgress: [],
              baselineAllowlist: [],
            };

      // No B-cap under isolation (locked decision): if the C-02 sandbox didn't run,
      // the run cannot honestly degrade to B — it failed to isolate. Fail closed.
      assertEgressRanUnderIsolation(egress, isolation, isStdio);

      // Same order and values as before — unrolled only so each completion can
      // report progress. C-04 runs LAST: its malformed/oversized inputs may
      // crash the server, so it must not run before the other probes have used
      // the live connection.
      const c01 = await c01Injection(ctx);
      step(2, "C-01 tool-output injection");
      const c02 = c02Permission(probe21Declaration(annotated), egress);
      step(3, "C-02 permission / egress");
      const c03 = await c03Sensitive(ctx, egress);
      step(4, "C-03 sensitive-data handling");
      const c04 = await c04Adversarial(ctx);
      step(5, "C-04 adversarial-input handling");
      const categories = [c01, c02, c03, c04];
      const grade = gradeFromCategories(categories);

      return assembleBundle({
        serverRef: conn.serverRef,
        resolvedVersion: conn.resolvedVersion,
        selfReportedVersion: conn.selfReportedVersion,
        // Surface the server's declared egress in the bundle (disclosure: a
        // declaration is not exoneration — the consumer/agent-gate can judge).
        target: egress.declaredEgress.length ? { ...conn.descriptor, declaredEgress: egress.declaredEgress } : conn.descriptor,
        toolDefsFingerprint: fingerprint,
        toolDefs: canonical,
        categories,
        grade,
        ranAt,
        dockerAvailable,
        // Record how a stdio target was executed; omit for http.
        ...(isStdio ? { stdioIsolation: isolation } : {}),
        ...(opts.disclaimer ? { disclaimer: opts.disclaimer } : {}),
      });
    };

    return opts.timeoutMs !== undefined
      ? await withTimeout(runProbes(), opts.timeoutMs, `litmus run exceeded ${opts.timeoutMs}ms`)
      : await runProbes();
  } finally {
    await conn.teardown();
    seed?.cleanup();
  }
}

/**
 * Fail-closed guard for the locked "no B-cap under isolation" decision: under
 * `isolation:"docker"` against a stdio target, the C-02 egress sandbox MUST have
 * run. If it didn't, the run failed to isolate the target — we refuse to emit a
 * bundle rather than silently degrade to B. Extracted so the decision is unit-
 * testable without driving Docker. No-op when isolation is "none" or http.
 */
export function assertEgressRanUnderIsolation(
  egress: EgressResult,
  isolation: "none" | "docker",
  isStdio: boolean,
): void {
  if (isolation === "docker" && isStdio && !egress.ran) {
    throw new Error(
      `stdio isolation failed: the egress sandbox did not run (${egress.reason ?? "unknown reason"}) — refusing to grade without isolation`,
    );
  }
}

/** A server that won't even list its tools within this bound fails loudly, rather than hanging. */
const LIST_TIMEOUT_MS = 30_000;

/** Upper bounds on a tool surface we are willing to fingerprint/scan. A hostile
 *  server can otherwise return millions of tools or multi-MB descriptions to
 *  exhaust memory or make the scanners do quadratic work. */
const MAX_TOOLS = 4096;
const MAX_SURFACE_BYTES = 8 * 1024 * 1024;

function assertGradableSurface(tools: readonly ToolDef[]): void {
  if (tools.length > MAX_TOOLS) {
    throw new Error(`tool surface too large to grade: ${tools.length} tools (max ${MAX_TOOLS})`);
  }
  let bytes = 0;
  for (const t of tools) {
    bytes += (t.name?.length ?? 0) + (t.description?.length ?? 0);
    if (bytes > MAX_SURFACE_BYTES) {
      throw new Error(`tool surface exceeds ${MAX_SURFACE_BYTES} bytes — refusing to grade`);
    }
  }
}

/** The fields of a `tools/list` entry the harness reads. */
interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}
export interface ListToolsClient {
  listTools(params?: { cursor?: string }): Promise<{ tools?: ListedTool[]; nextCursor?: string }>;
}

/**
 * Follow `tools/list` pagination to the end, accumulating the full tool surface.
 * The MCP SDK's `listTools()` returns a single page and does not auto-paginate,
 * so a server can park a tool (e.g. `transfer_funds`) or a poisoned description
 * behind a `nextCursor` — invisible to a one-page lister, yet served to a real
 * agent. We enumerate every page so the fingerprint and grade cover what the
 * agent actually gets, and **fail closed**: if the server is still paginating
 * past the gradable cap, we refuse rather than grade a partial surface.
 */
export async function enumerateTools(
  client: ListToolsClient,
  opts: { maxTools?: number; maxBytes?: number; listTimeoutMs?: number } = {},
): Promise<ListedTool[]> {
  const maxTools = opts.maxTools ?? MAX_TOOLS;
  const maxBytes = opts.maxBytes ?? MAX_SURFACE_BYTES;
  const listTimeoutMs = opts.listTimeoutMs ?? LIST_TIMEOUT_MS;
  const all: ListedTool[] = [];
  let bytes = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await withTimeout(
      client.listTools(cursor !== undefined ? { cursor } : undefined),
      listTimeoutMs,
      "listTools timed out",
    );
    for (const t of page.tools ?? []) {
      all.push(t);
      bytes += (t.name?.length ?? 0) + (t.description?.length ?? 0);
    }
    cursor = page.nextCursor;
    if (cursor === undefined) break;
    if (all.length > maxTools || bytes > maxBytes) {
      throw new Error(
        `tool surface still paginating past the gradable cap (>${maxTools} tools / >${maxBytes} bytes) — refusing to grade a partial surface`,
      );
    }
  }
  return all;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(label)), ms);
      t.unref?.();
    }),
  ]);
}

/** True if a Docker daemon is reachable (governs C-02 / probe 4.2, and the CLI's
 *  detect-and-confirm sandbox prompt). */
export function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile("docker", ["info"], { timeout: 4000 }, (err) => resolve(!err));
    child.on("error", () => resolve(false));
  });
}
