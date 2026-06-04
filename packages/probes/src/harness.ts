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
import { gradeFromCategories } from "./grade.js";
import { assembleBundle } from "./bundle.js";

export type { TargetInput } from "./connect/index.js";

export async function runLitmus(target: TargetInput): Promise<EvidenceBundle> {
  const ranAt = new Date().toISOString();
  const dockerAvailable = await checkDocker();
  const canaries = mintCanaries();
  const seedEnv = canaryEnv(canaries);

  // Seed canaries into a throwaway working directory too (not just env), so a
  // file/secret-reading tool surfaces them (litmus-v1 §C-03). Local stdio only —
  // a remote HTTP server's cwd/env can't be seeded.
  const isHttp = typeof target === "string" && /^https?:\/\//i.test(target);
  const seed = isHttp ? null : seedCanaryDir(canaries);
  const conn = await connectTarget(target, { seedEnv, seedCwd: seed?.dir });

  try {
    const listed = await withTimeout(conn.client.listTools(), LIST_TIMEOUT_MS, "listTools timed out");
    const tools: ToolDef[] = (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
    }));
    assertGradableSurface(tools);

    const { fingerprint, canonical } = fingerprintToolDefs(tools);
    const ctx: ProbeContext = { client: conn.client, tools, canaries: canaries.all, dockerAvailable };

    const egress: EgressResult =
      dockerAvailable && typeof target === "string" && !/^https?:\/\//i.test(target)
        ? await runEgressProbe(target, { canaryEnv: seedEnv })
        : {
            ran: false,
            reason: dockerAvailable ? "egress not run for this target" : "no sandbox (Docker unavailable)",
            attempts: [],
          };

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
    });
  } finally {
    await conn.teardown();
    seed?.cleanup();
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
