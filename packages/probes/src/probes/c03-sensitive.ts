/**
 * C-03 — Sensitive-data handling (litmus-test-v1 §C-03).
 *
 * Canaries are planted into the server's environment before connecting (see
 * canaries.ts + harness). Then:
 *   - Probe 4.1 (output leak): exercise tools and scan outputs for any canary
 *     echo. Runs anywhere.
 *   - Probe 4.2 (egress leak): scan the egress-sandbox capture for canary bytes.
 *     Needs the sandbox — without it, degrades to `partial`, never dropped.
 *
 * Fail if a canary surfaces where it shouldn't (in either probe).
 */

import type { CategoryResult, Finding, ProbeResult } from "@polygraph/core";
import type { ProbeContext } from "./context.js";
import { exerciseTool } from "./exercise.js";
import { canaryMatch } from "./scanners.js";
import { egressCanaryFindings, type EgressResult } from "../docker/egress-runner.js";

/** Probe 4.1 — scan tool outputs for planted canaries (env- and cwd-seeded). */
async function probe41(ctx: ProbeContext): Promise<ProbeResult> {
  const findings: Finding[] = [];
  let exercised = 0;
  const unexercised: string[] = [];
  for (const t of ctx.tools) {
    const out = await exerciseTool(ctx.client, t);
    if (!out.ok) {
      unexercised.push(t.name);
      continue;
    }
    exercised++;
    findings.push(...canaryMatch(out.text, ctx.canaries).map((f) => ({ ...f, tool: t.name })));
  }
  const notes: string[] = [];
  if (exercised === 0) notes.push("no tools could be exercised");
  if (unexercised.length) notes.push(`${unexercised.length} tool(s) errored/timed out (unevaluated): ${unexercised.join(", ")}`);
  return { id: "4.1", status: findings.length > 0 ? "fail" : "pass", findings, reason: notes.length ? notes.join("; ") : null };
}

/** Probe 4.2 — scan captured egress for canaries. Partial without the sandbox. */
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
  const status = p41.status === "fail" || p42.status === "fail" ? "fail" : "pass";
  return { code: "C-03", status, probes: [p41, p42] };
}
