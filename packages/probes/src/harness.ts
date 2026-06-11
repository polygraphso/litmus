/**
 * The harness orchestrator (technical-design §3): connect → fingerprint →
 * probes → grade → bundle. Public entry point: `runLitmus`.
 */

import { execFile } from "node:child_process";
import type { EvidenceBundle, ToolDef } from "@polygraph/core";
import { connectTarget, type TargetInput } from "./connect/index.js";
import { fingerprintToolDefs } from "./fingerprint.js";
import { c01Injection } from "./probes/c01-injection.js";
import { c02Egress } from "./probes/c02-egress.js";
import { c03Sensitive } from "./probes/c03-sensitive.js";
import { canaryEnv, mintCanaries, seedCanaryDir } from "./probes/canaries.js";
import { runEgressProbe, type EgressResult } from "./docker/egress-runner.js";
import type { ProbeContext } from "./probes/context.js";
import { stateChangingToolNames, type ToolAnnotations } from "./probes/tool-safety.js";
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
}

export async function runLitmus(target: TargetInput, opts: RunLitmusOptions = {}): Promise<EvidenceBundle> {
  const isolation: "none" | "docker" =
    opts.isolation ?? (process.env.LITMUS_STDIO_ISOLATION === "docker" ? "docker" : "none");
  const ranAt = new Date().toISOString();
  const dockerAvailable = await checkDocker();
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
    const listed = await withTimeout(conn.client.listTools(), LIST_TIMEOUT_MS, "listTools timed out");
    const tools: ToolDef[] = (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
    }));
    assertGradableSurface(tools);

    const { fingerprint, canonical } = fingerprintToolDefs(tools);
    // Classify from the RAW list (annotations are dropped from ToolDef — they
    // must never enter the fingerprint hash) to decide which tools are unsafe
    // to actively call. The static scan still covers all of them.
    const stateChangingTools = stateChangingToolNames(
      (listed.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        annotations: t.annotations as ToolAnnotations | undefined,
      })),
    );
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
        ? await runEgressProbe(target, { canaryEnv: seedEnv, ...(opts.runLabel ? { runLabel: opts.runLabel } : {}) })
        : {
            ran: false,
            reason: dockerAvailable ? "egress not run for this target" : "no sandbox (Docker unavailable)",
            attempts: [],
          };

    // No B-cap under isolation (locked decision): if the C-02 sandbox didn't run,
    // the run cannot honestly degrade to B — it failed to isolate. Fail closed.
    assertEgressRanUnderIsolation(egress, isolation, isStdio);

    const categories = [await c01Injection(ctx), c02Egress(egress), await c03Sensitive(ctx, egress)];
    const grade = gradeFromCategories(categories);

    return assembleBundle({
      serverRef: conn.serverRef,
      resolvedVersion: conn.resolvedVersion,
      target: conn.descriptor,
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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(label)), ms);
      t.unref?.();
    }),
  ]);
}

/** True if a Docker daemon is reachable (governs C-02 / probe 4.2). */
function checkDocker(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile("docker", ["info"], { timeout: 4000 }, (err) => resolve(!err));
    child.on("error", () => resolve(false));
  });
}
