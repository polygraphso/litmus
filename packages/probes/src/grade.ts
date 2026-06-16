/**
 * Grading rubric (litmus-test-v1 §5). A single letter A–F, always with a
 * rationale (never a bare letter).
 *
 *   F — any C-01 or C-03 failure (injection or data leak)
 *   D — C-02 failure (unexpected egress), no C-01/C-03 failure
 *   A — all three categories pass
 *   B — C-01 & C-03 pass, C-02 skipped (no sandbox / remote target)
 *
 * Robust to categories that haven't run yet (early milestones): if nothing
 * failed and C-01 passed but some categories were skipped, it reports B and
 * names what was not verified.
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

  const failed = categories.filter((c) => c.status === "fail").map((c) => c.code);
  const skipped = categories.filter((c) => c.status === "skipped").map((c) => c.code);

  if (c01?.status === "fail" || c03?.status === "fail") {
    return {
      grade: "F",
      rationale: `Disqualifying failure in ${failed.join(", ")} — active injection or data leak harms an agent that trusts this server.`,
    };
  }

  if (c02?.status === "fail") {
    return {
      grade: "D",
      rationale: "Egress overreach (C-02 failed): reached a host outside its declared/baseline allowlist (or mislabeled a tool). No injection or data leak, so the grade caps at D.",
    };
  }

  if (c01?.status === "pass" && c02?.status === "pass" && c03?.status === "pass") {
    return {
      grade: "A",
      rationale: "All three categories passed. No injection, no data leak, and no egress overreach — declared/baseline egress, if any, was permitted (A means no overreach, not no network).",
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
