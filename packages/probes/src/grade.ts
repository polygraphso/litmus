/**
 * Grading rubric (litmus-test-v1 §5). A single letter A–F, always with a
 * rationale (never a bare letter).
 *
 *   F — any C-01 or C-03 failure (injection or data leak)
 *   D — C-02 or C-04 failure (egress overreach, or a crash / internals-leak /
 *       jailbreak amplification on adversarial input), no C-01/C-03 failure
 *   A — all four categories pass
 *   B — C-01 & C-03 pass, C-02 skipped (no sandbox / remote target)
 *
 * F is reserved for the two PROVEN, directly-agent-harming failures (injection,
 * leak); the robustness/overreach-class failures (C-02, C-04) cap at D. Robust to
 * categories that haven't run (early milestones / a skipped C-02): if nothing
 * failed and C-01 passed but some categories were skipped, it reports B and names
 * what was not verified — a skipped category never grants A.
 */

import type { CategoryResult, LitmusGrade } from "@polygraph/core";

export interface Grade {
  grade: LitmusGrade;
  rationale: string;
}

export function gradeFromCategories(categories: readonly CategoryResult[]): Grade {
  const byCode = (code: string) => categories.find((c) => c.code === code);
  const c01 = byCode("C-01");
  const c02 = byCode("C-02");
  const c03 = byCode("C-03");
  const c04 = byCode("C-04");

  const failed = categories.filter((c) => c.status === "fail").map((c) => c.code);
  const skipped = categories.filter((c) => c.status === "skipped").map((c) => c.code);

  if (c01?.status === "fail" || c03?.status === "fail") {
    return {
      grade: "F",
      rationale: `Disqualifying failure in ${failed.join(", ")} — active injection or data leak harms an agent that trusts this server.`,
    };
  }

  if (c02?.status === "fail" || c04?.status === "fail") {
    return {
      grade: "D",
      rationale:
        c04?.status === "fail" && c02?.status !== "fail"
          ? "Adversarial input handling failed (C-04): the server crashed, leaked internals (a stack trace), or amplified hostile input. No injection or data leak, so the grade caps at D."
          : "Egress overreach (C-02 failed): reached a host outside its declared/baseline allowlist (or mislabeled a tool). No injection or data leak, so the grade caps at D.",
    };
  }

  if (c01?.status === "pass" && c02?.status === "pass" && c03?.status === "pass" && c04?.status === "pass") {
    return {
      grade: "A",
      rationale: "All four categories passed. No injection, no data leak, no egress overreach, and adversarial inputs were handled cleanly (A means no overreach, not no network).",
    };
  }

  if (c01?.status === "pass") {
    const note = skipped.length
      ? ` Not verified: ${skipped.join(", ")} (${skipped.map((c) => byCode(c)?.reason).filter(Boolean).join("; ")}).`
      : "";
    return {
      grade: "B",
      rationale: `Injection checks passed; egress not verified.${note}`,
    };
  }

  // C-01 itself did not produce a pass (e.g. couldn't connect/list tools).
  return {
    grade: "F",
    rationale: "C-01 did not complete — the tool surface could not be evaluated, so the server is treated as ungraded/unsafe.",
  };
}
