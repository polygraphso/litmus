import { describe, it, expect } from "vitest";
import { gradeFromCategories } from "./grade.js";
import type { CategoryResult, CategoryStatus } from "@polygraph/core";

/**
 * §5 rubric — checked as an 81-combo truth table (every C-01 × C-02 × C-03 × C-04
 * combination), so a drift in `gradeFromCategories` fails a concrete case. C-04
 * (litmus-v4) joins C-02 at the D cap; F stays reserved for C-01/C-03.
 */

const V: CategoryStatus[] = ["pass", "fail", "skipped"];
const U8 = { pass: 0, fail: 1, skipped: 2 } as const;

function expectedGrade(c01: number, c02: number, c03: number, c04: number): string {
  if (c01 === 1 || c03 === 1) return "F";
  if (c02 === 1 || c04 === 1) return "D";
  if (c01 === 0 && c02 === 0 && c03 === 0 && c04 === 0) return "A";
  if (c01 === 0) return "B";
  return "F";
}

function cats(c01: CategoryStatus, c02: CategoryStatus, c03: CategoryStatus, c04: CategoryStatus): CategoryResult[] {
  return [
    { code: "C-01", status: c01, probes: [] },
    { code: "C-02", status: c02, probes: [] },
    { code: "C-03", status: c03, probes: [] },
    { code: "C-04", status: c04, probes: [] },
  ];
}

describe("gradeFromCategories — §5 rubric", () => {
  it("matches the rubric across all 81 verdict combos (C-01 × C-02 × C-03 × C-04)", () => {
    for (const c01 of V)
      for (const c02 of V)
        for (const c03 of V)
          for (const c04 of V) {
            const got = gradeFromCategories(cats(c01, c02, c03, c04)).grade;
            expect(got, `${c01}/${c02}/${c03}/${c04}`).toBe(expectedGrade(U8[c01], U8[c02], U8[c03], U8[c04]));
          }
  });

  it("a C-04 failure caps at D (not F) and only when C-01/C-03 are clean", () => {
    expect(gradeFromCategories(cats("pass", "pass", "pass", "fail")).grade).toBe("D");
    expect(gradeFromCategories(cats("fail", "pass", "pass", "fail")).grade).toBe("F"); // C-01 still floors to F
  });

  it("always carries a rationale, never a bare letter", () => {
    for (const c of [
      cats("pass", "pass", "pass", "pass"),
      cats("fail", "pass", "pass", "pass"),
      cats("pass", "skipped", "pass", "pass"),
      cats("pass", "pass", "pass", "fail"),
    ]) {
      expect(gradeFromCategories(c).rationale.length).toBeGreaterThan(0);
    }
  });
});
