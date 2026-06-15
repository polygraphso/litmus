/**
 * C-02 — Permission overreach (litmus-test-v1 §C-02). Two probes:
 *
 *  - **2.1 declared-permission honesty** — a tool that annotates itself
 *    `readOnlyHint:true` while its name plainly mutates is lying about its
 *    permissions; an agent (and this harness) would otherwise auto-trust it.
 *    Static, deterministic, no sandbox — so it can fail even a remote target.
 *  - **2.2 unexpected egress** — the egress sandbox (docker/egress-runner.ts)
 *    runs the target and captures what it tried to reach; any outbound attempt
 *    during a no-expected-egress run is a finding. When the sandbox didn't run
 *    (no Docker / non-launchable target), 2.2 is `skipped` — never silently
 *    dropped (the grade caps at B).
 *
 * Category verdict: a 2.1 or 2.2 failure fails C-02 (→ grade D). C-02 is only
 * `skipped` when 2.1 passed and 2.2 could not run.
 */

import type { CategoryResult, CategoryStatus, Finding, ProbeResult } from "@polygraph/core";
import { egressToFindings, type EgressResult } from "../docker/egress-runner.js";
import { declarationMismatch, type ToolSafetyInput } from "./tool-safety.js";

/** Probe 2.1 — flag tools that claim read-only but carry a destructive name. */
export function probe21Declaration(tools: readonly ToolSafetyInput[]): ProbeResult {
  const findings: Finding[] = [];
  for (const t of tools) {
    const verb = declarationMismatch(t);
    if (verb) {
      findings.push({
        kind: "permission-mislabel",
        severity: "high",
        match: `claims readOnlyHint:true but name verb "${verb}" mutates`,
        tool: t.name,
      });
    }
  }
  return { id: "2.1", status: findings.length > 0 ? "fail" : "pass", findings };
}

/** Probe 2.2 — turn the egress capture into a probe result (skipped if no sandbox). */
function probe22Egress(egress: EgressResult): ProbeResult {
  if (!egress.ran) return { id: "2.2", status: "skipped", findings: [], reason: egress.reason };
  const findings = egressToFindings(egress.attempts);
  return { id: "2.2", status: findings.length > 0 ? "fail" : "pass", findings };
}

/** Assemble the C-02 category from probe 2.1 (declaration) and probe 2.2 (egress). */
export function c02Permission(declaration: ProbeResult, egress: EgressResult): CategoryResult {
  const egressProbe = probe22Egress(egress);
  const probes = [declaration, egressProbe];

  let status: CategoryStatus;
  if (declaration.status === "fail" || egressProbe.status === "fail") {
    status = "fail";
  } else if (egressProbe.status === "skipped") {
    // 2.1 passed, egress couldn't run: honest about not verifying egress (B-cap).
    return { code: "C-02", status: "skipped", reason: egress.reason, probes };
  } else {
    status = "pass";
  }
  return { code: "C-02", status, probes };
}
