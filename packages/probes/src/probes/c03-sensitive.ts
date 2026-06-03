/**
 * C-03 — Sensitive-data handling (litmus-test-v1 §C-03).
 *
 * Plants canaries (fake API key / PII / token), then scans tool outputs (4.1)
 * and the egress sinkhole (4.2) for them. Probe 4.1 runs anywhere; 4.2 needs
 * the sandbox.
 *
 * M1 stub: returns `skipped`. Full canary planting + scans land in M2.
 */

import type { CategoryResult } from "@polygraph/core";
import type { ProbeContext } from "./context.js";

export async function c03Sensitive(_ctx: ProbeContext): Promise<CategoryResult> {
  // TODO(M2): plant canaries → probe 4.1 (output leak) + 4.2 (egress leak).
  const reason = "sensitive-data probes not yet implemented (M2)";
  return {
    code: "C-03",
    status: "skipped",
    reason,
    probes: [
      { id: "4.1", status: "skipped", findings: [], reason },
      { id: "4.2", status: "skipped", findings: [], reason },
    ],
  };
}
