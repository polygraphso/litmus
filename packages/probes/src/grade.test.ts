import { describe, it, expect } from "vitest";
import { gradeFromCategories } from "./grade.js";
import type { CategoryResult, CategoryStatus } from "@polygraph/core";

/**
 * §5 rubric — checked as a 27-combo truth table. The SAME reference is used to
 * check the Solidity port (`LitmusGrade.gradeLetter`) in
 * packages/contracts/test/LitmusGrade.ts. One rubric, both implementations: if
 * either drifts, one of the two suites fails, which is exactly what keeps the
 * on-chain `proveGradeInconsistent` honest.
 */

const V: CategoryStatus[] = ["pass", "fail", "skipped"];
const U8 = { pass: 0, fail: 1, skipped: 2 } as const;

function expectedGrade(c01: number, c02: number, c03: number): string {
  if (c01 === 1 || c03 === 1) return "F";
  if (c02 === 1) return "D";
  if (c01 === 0 && c02 === 0 && c03 === 0) return "A";
  if (c01 === 0) return "B";
  return "F";
}

function cats(c01: CategoryStatus, c02: CategoryStatus, c03: CategoryStatus): CategoryResult[] {
  return [
    { code: "C-01", status: c01, probes: [] },
    { code: "C-02", status: c02, probes: [] },
    { code: "C-03", status: c03, probes: [] },
  ];
}

describe("gradeFromCategories — §5 rubric", () => {
  it("matches the rubric across all 27 verdict combos (mirror of the Solidity port)", () => {
    for (const c01 of V)
      for (const c02 of V)
        for (const c03 of V) {
          const got = gradeFromCategories(cats(c01, c02, c03)).grade;
          expect(got, `${c01}/${c02}/${c03}`).toBe(expectedGrade(U8[c01], U8[c02], U8[c03]));
        }
  });

  it("always carries a rationale, never a bare letter", () => {
    for (const c of [cats("pass", "pass", "pass"), cats("fail", "pass", "pass"), cats("pass", "skipped", "pass")]) {
      expect(gradeFromCategories(c).rationale.length).toBeGreaterThan(0);
    }
  });
});
