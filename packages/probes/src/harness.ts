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
import { canaryEnv, mintCanaries } from "./probes/canaries.js";
import type { ProbeContext } from "./probes/context.js";
import { gradeFromCategories } from "./grade.js";
import { assembleBundle } from "./bundle.js";

export type { TargetInput } from "./connect/index.js";

export async function runLitmus(target: TargetInput): Promise<EvidenceBundle> {
  const ranAt = new Date().toISOString();
  const dockerAvailable = await checkDocker();
  const canaries = mintCanaries();
  const conn = await connectTarget(target, { seedEnv: canaryEnv(canaries) });

  try {
    const listed = await conn.client.listTools();
    const tools: ToolDef[] = (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
    }));

    const { fingerprint, canonical } = fingerprintToolDefs(tools);
    const ctx: ProbeContext = { client: conn.client, tools, canaries: canaries.all, dockerAvailable };

    const categories = [await c01Injection(ctx), await c02Egress(ctx), await c03Sensitive(ctx)];
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
  }
}

/** True if a Docker daemon is reachable (governs C-02 / probe 4.2). */
function checkDocker(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile("docker", ["info"], { timeout: 4000 }, (err) => resolve(!err));
    child.on("error", () => resolve(false));
  });
}
