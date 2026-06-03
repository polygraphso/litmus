/**
 * C-02 — Permission overreach / unexpected egress (litmus-test-v1 §C-02).
 *
 * The egress sandbox (docker/egress-runner.ts) runs the target and captures what
 * it tried to reach. This module turns that capture into the category verdict:
 * any outbound attempt during a no-expected-egress run is a finding. When the
 * sandbox didn't run (no Docker / non-launchable target), reports `skipped` —
 * never silently dropped (the grade caps at B).
 */

import type { CategoryResult } from "@polygraph/core";
import { egressToFindings, type EgressResult } from "../docker/egress-runner.js";

export function c02Egress(egress: EgressResult): CategoryResult {
  if (!egress.ran) {
    return {
      code: "C-02",
      status: "skipped",
      reason: egress.reason,
      probes: [{ id: "2.2", status: "skipped", findings: [], reason: egress.reason }],
    };
  }
  const findings = egressToFindings(egress.attempts);
  const status = findings.length > 0 ? "fail" : "pass";
  return { code: "C-02", status, probes: [{ id: "2.2", status, findings }] };
}
