/**
 * Skill grading rubric — a strict structural mirror of `grade.ts gradeFromCategories`,
 * for skill categories (S-*). Fail-first, always with a rationale.
 *
 *   F — any S-01 (injection) or S-03 (exfil instruction) failure; disqualifying.
 *   D — any S-04 (dangerous bundled command) or S-05 (tool/permission overreach)
 *       failure, with no S-01/S-03 failure; capped.
 *   A — all present categories pass.
 *   B — S-01 & S-03 pass but a category was skipped (e.g. no bundle ⇒ S-04 skipped);
 *       a skipped category never grants A.
 *   F — fallthrough when S-01 did not complete (e.g. an unparseable SKILL.md):
 *       ungraded == unsafe.
 *
 * STRICT ALPHABET: skills emit A/B/D/F only — never "C". The agent gate's
 * `DEFAULT_PASSING` is {A,B,C} and the hosted store rejects "C" (publish-check.ts),
 * so a stray "C" would silently become a transacting grade. A "works but smells"
 * signal belongs in the separate, non-letter quality channel.
 */
import type { CategoryStatus, Finding, LitmusGrade } from "@polygraph/core";

export type SkillCategoryCode = "S-01" | "S-03" | "S-04" | "S-05";

/** Categories that disqualify (F) on failure, mirroring C-01/C-03. */
const DISQUALIFYING: ReadonlySet<SkillCategoryCode> = new Set(["S-01", "S-03"]);
/** Categories that cap the grade at D on failure, mirroring C-02/C-04. */
const CAPPING: ReadonlySet<SkillCategoryCode> = new Set(["S-04", "S-05"]);

export interface SkillCategoryResult {
  code: SkillCategoryCode;
  status: CategoryStatus;
  reason?: string | null;
  findings: Finding[];
}

export interface SkillGrade {
  grade: LitmusGrade;
  rationale: string;
}

export function gradeSkillCategories(categories: readonly SkillCategoryResult[]): SkillGrade {
  const byCode = (code: SkillCategoryCode) => categories.find((c) => c.code === code);
  const s01 = byCode("S-01");

  const failed = categories.filter((c) => c.status === "fail").map((c) => c.code);
  const skipped = categories.filter((c) => c.status === "skipped").map((c) => c.code);

  if (failed.some((c) => DISQUALIFYING.has(c))) {
    const which = failed.filter((c) => DISQUALIFYING.has(c)).join(", ");
    return {
      grade: "F",
      rationale: `Disqualifying failure in ${which} — the skill instructs prompt injection or data exfiltration into an agent that loads it.`,
    };
  }

  if (failed.some((c) => CAPPING.has(c))) {
    const which = failed.filter((c) => CAPPING.has(c)).join(", ");
    return {
      grade: "D",
      rationale: `Overreach in ${which} — a dangerous bundled command or an undeclared capability. No injection or exfil instruction, so the grade caps at D.`,
    };
  }

  // S-01 must have produced a pass to certify anything.
  if (s01?.status !== "pass") {
    return {
      grade: "F",
      rationale: "S-01 did not complete — the SKILL.md could not be parsed/scanned, so the skill is treated as ungraded/unsafe.",
    };
  }

  const allPass = categories.every((c) => c.status === "pass");
  if (allPass) {
    return {
      grade: "A",
      rationale: "All skill categories passed: no injection or exfil instruction in the body, and no dangerous bundled command or undeclared capability. A reflects static scanning, not behavioral proof.",
    };
  }

  const note = skipped.length
    ? ` Not verified: ${skipped.join(", ")} (${skipped.map((c) => byCode(c)?.reason).filter(Boolean).join("; ")}).`
    : "";
  return {
    grade: "B",
    rationale: `Injection and exfil checks passed; some categories not verified.${note}`,
  };
}
