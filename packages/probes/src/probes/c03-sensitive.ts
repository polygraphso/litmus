/**
 * C-03 — Sensitive-data handling (litmus-test-v1 §C-03).
 *
 * Canaries are planted into the server's environment before connecting (see
 * canaries.ts + harness). Then:
 *   - Probe 4.1 (output leak): exercise tools and scan outputs for any canary
 *     echo. Runs anywhere.
 *   - Probe 4.2 (egress leak): scan the egress sinkhole for canary bytes.
 *     Requires the Docker sandbox — without it, degrades to `partial`
 *     (output-scan only), never silently dropped. Wired in M2's egress runner.
 *
 * Fail if a canary surfaces where it shouldn't (in either probe).
 */

import type { CategoryResult, Finding, ProbeResult } from "@polygraph/core";
import type { ProbeContext } from "./context.js";
import { exerciseTool } from "./exercise.js";
import { canaryMatch } from "./scanners.js";

/** Probe 4.1 — scan tool outputs for planted canaries. */
async function probe41(ctx: ProbeContext): Promise<ProbeResult> {
  const findings: Finding[] = [];
  let exercised = 0;
  for (const t of ctx.tools) {
    const out = await exerciseTool(ctx.client, t);
    if (out === null) continue;
    exercised++;
    findings.push(...canaryMatch(out, ctx.canaries).map((f) => ({ ...f, tool: t.name })));
  }
  const reason = exercised === 0 ? "no tools could be exercised" : null;
  return { id: "4.1", status: findings.length > 0 ? "fail" : "pass", findings, reason };
}

/** Probe 4.2 — egress-leak scan. Needs the sandbox; partial without it. */
function probe42(ctx: ProbeContext, egressFindings?: Finding[]): ProbeResult {
  if (!ctx.dockerAvailable) {
    return {
      id: "4.2",
      status: "partial",
      findings: [],
      reason: "no egress capture (sandbox unavailable)",
    };
  }
  const findings = egressFindings ?? [];
  return { id: "4.2", status: findings.length > 0 ? "fail" : "pass", findings };
}

export async function c03Sensitive(ctx: ProbeContext, egressFindings?: Finding[]): Promise<CategoryResult> {
  const p41 = await probe41(ctx);
  const p42 = probe42(ctx, egressFindings);
  const status = p41.status === "fail" || p42.status === "fail" ? "fail" : "pass";
  return { code: "C-03", status, probes: [p41, p42] };
}
