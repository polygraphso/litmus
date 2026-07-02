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

describe("gradeFromCategories — C-02 rationale wording (messaging only, grade unchanged)", () => {
  function c02Fail(probes: CategoryResult["probes"]): CategoryResult[] {
    return [
      { code: "C-01", status: "pass", probes: [] },
      { code: "C-02", status: "fail", probes },
      { code: "C-03", status: "pass", probes: [] },
      { code: "C-04", status: "pass", probes: [] },
    ];
  }

  it("names the undeclared egress hosts and points at polygraph.egress", () => {
    const g = gradeFromCategories(
      c02Fail([
        { id: "2.1", status: "pass", findings: [] },
        {
          id: "2.2",
          status: "fail",
          findings: [
            { kind: "egress", severity: "high", match: "telemetry.acme-metrics.com", host: "telemetry.acme-metrics.com", port: 443 },
            { kind: "egress", severity: "high", match: "telemetry.acme-metrics.com:8443", host: "telemetry.acme-metrics.com", port: 8443 },
          ],
        },
      ]),
    );
    expect(g.grade).toBe("D"); // unchanged
    expect(g.rationale).toContain("telemetry.acme-metrics.com");
    expect(g.rationale).toContain("polygraph.egress");
    expect(g.rationale).not.toMatch(/telemetry\.acme-metrics\.com.*telemetry\.acme-metrics\.com/s); // host de-duped
  });

  it("uses a permission-mislabel message when only 2.1 failed", () => {
    const g = gradeFromCategories(
      c02Fail([
        { id: "2.1", status: "fail", findings: [{ kind: "permission-mislabel", severity: "high", match: "x", tool: "t" }] },
        { id: "2.2", status: "pass", findings: [] },
      ]),
    );
    expect(g.grade).toBe("D");
    expect(g.rationale).toMatch(/mislabel/i);
    expect(g.rationale).not.toContain("polygraph.egress");
  });

  it("falls back to a generic D rationale when probe detail is absent", () => {
    const g = gradeFromCategories(c02Fail([]));
    expect(g.grade).toBe("D");
    expect(g.rationale.length).toBeGreaterThan(0);
  });
});
