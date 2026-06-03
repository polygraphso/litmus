/**
 * C-02 — Permission overreach / unexpected egress (litmus-test-v1 §C-02).
 *
 * Runs the server in a default-deny Docker container with a local sinkhole and
 * flags any outbound connection attempt. Requires the harness to run the server
 * itself (local package) + Docker.
 *
 * M1 stub: returns `skipped`. The full sandbox + fallback ladder lands in M2
 * (`docker/egress-runner.ts`, technical-design §4).
 */

import type { CategoryResult } from "@polygraph/core";
import type { ProbeContext } from "./context.js";

export async function c02Egress(ctx: ProbeContext): Promise<CategoryResult> {
  // TODO(M2): default-deny Docker container + sinkhole; fallback ladder
  // sinkhole → `--network none` → skip. Until then, report skipped honestly.
  const reason = ctx.dockerAvailable
    ? "egress sandbox not yet implemented (M2)"
    : "no sandbox (Docker unavailable)";
  return {
    code: "C-02",
    status: "skipped",
    reason,
    probes: [{ id: "2.2", status: "skipped", findings: [], reason }],
  };
}
