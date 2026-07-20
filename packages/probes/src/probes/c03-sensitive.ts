/**
 * C-03: sensitive-data handling (litmus-test-v1 §C-03).
 *
 * Canaries are planted into the server's environment before connecting (see
 * canaries.ts + harness). Then:
 *   - Probe 4.1 (output leak): exercise tools and scan outputs for any canary
 *     echo. Runs anywhere a canary was actually planted.
 *   - Probe 4.2 (egress leak): scan the egress-sandbox capture for canary bytes.
 *     Needs the sandbox; without it, degrades to `partial`, never dropped.
 *
 * Fail if a canary surfaces where it shouldn't (in either probe). A remote
 * (http) target gets no planted canary at all (see ProbeContext.canaryPlanted,
 * litmus-v17): scanning its output for something that was never placed cannot
 * verify anything, so probe 4.1 is honestly `skipped` there instead of an
 * unearned pass, and the category resolves to `skipped` too, unless a real
 * leak turned up some other way.
 */

import type { CategoryResult, CategoryStatus, Finding, ProbeResult } from "@polygraph/core";
import type { ProbeContext } from "./context.js";
import { exerciseTool } from "./exercise.js";
import { shouldSkipExercise, skippedNote } from "./tool-safety.js";
import { canaryMatch } from "./scanners.js";
import { egressCanaryFindings, type EgressResult } from "../docker/egress-runner.js";

/** Reason recorded when probe 4.1 is skipped: nothing was planted to find. */
const NO_CANARY_REASON = "no canary could be planted on a remote target";

/** Probe 4.1: scan tool outputs for planted canaries (env- and cwd-seeded).
 *  Skipped outright when nothing was planted (litmus-v17). */
async function probe41(ctx: ProbeContext): Promise<ProbeResult> {
  if (ctx.canaryPlanted === false) {
    return { id: "4.1", status: "skipped", findings: [], reason: NO_CANARY_REASON };
  }
  const findings: Finding[] = [];
  let exercised = 0;
  const unexercised: string[] = [];
  const skipped: string[] = [];
  for (const t of ctx.tools) {
    // State-changing tools are not bait-called by default; see tool-safety.ts.
    if (shouldSkipExercise(ctx, t.name)) {
      skipped.push(t.name);
      continue;
    }
    const out = await exerciseTool(ctx.client, t);
    if (!out.ok) {
      unexercised.push(t.name);
      continue;
    }
    exercised++;
    findings.push(...canaryMatch(out.text, ctx.canaries).map((f) => ({ ...f, tool: t.name })));
  }
  const notes: string[] = [];
  if (exercised === 0 && skipped.length === 0) notes.push("no tools could be exercised");
  if (skipped.length) notes.push(skippedNote(skipped));
  if (unexercised.length) notes.push(`${unexercised.length} tool(s) errored/timed out (unevaluated): ${unexercised.join(", ")}`);
  return { id: "4.1", status: findings.length > 0 ? "fail" : "pass", findings, reason: notes.length ? notes.join("; ") : null };
}

/** Probe 4.2: scan captured egress for canaries. Partial without the sandbox. */
function probe42(ctx: ProbeContext, egress: EgressResult): ProbeResult {
  if (!egress.ran) {
    return {
      id: "4.2",
      status: "partial",
      findings: [],
      reason: egress.reason ?? "no egress capture (sandbox unavailable)",
    };
  }
  const findings = egressCanaryFindings(egress.attempts, ctx.canaries);
  return { id: "4.2", status: findings.length > 0 ? "fail" : "pass", findings };
}

export async function c03Sensitive(ctx: ProbeContext, egress: EgressResult): Promise<CategoryResult> {
  const p41 = await probe41(ctx);
  const p42 = probe42(ctx, egress);
  let status: CategoryStatus;
  if (p41.status === "fail" || p42.status === "fail") {
    status = "fail";
  } else if (p41.status === "skipped") {
    // Nothing was planted (remote target): honest about not verifying C-03
    // rather than reporting a pass we never earned (B-cap, litmus-v17).
    return { code: "C-03", status: "skipped", reason: p41.reason, probes: [p41, p42] };
  } else {
    status = "pass";
  }
  return { code: "C-03", status, probes: [p41, p42] };
}
