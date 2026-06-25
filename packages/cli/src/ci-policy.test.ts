import { describe, it, expect } from "vitest";
import { gradeRank, gate, GRADE_ORDER } from "./ci-policy.js";

describe("gradeRank", () => {
  it("orders A best to F worst", () => {
    expect(GRADE_ORDER).toEqual(["A", "B", "C", "D", "F"]);
    expect(gradeRank("A")).toBeLessThan(gradeRank("B"));
    expect(gradeRank("D")).toBeLessThan(gradeRank("F"));
  });
});

describe("gate — default (fail on D/F)", () => {
  it("passes A and B", () => {
    expect(gate({ grade: "A", source: "live" }).gated).toBe(false);
    expect(gate({ grade: "B", source: "published" }).gated).toBe(false);
  });
  it("fails D and F", () => {
    expect(gate({ grade: "D", source: "live" }).gated).toBe(true);
    expect(gate({ grade: "F", source: "live" }).gated).toBe(true);
  });
});

describe("gate — min-grade", () => {
  it("fails anything worse than the minimum", () => {
    expect(gate({ grade: "C", source: "live" }, { minGrade: "B" }).gated).toBe(true);
    expect(gate({ grade: "B", source: "live" }, { minGrade: "B" }).gated).toBe(false);
    expect(gate({ grade: "B", source: "live" }, { minGrade: "A" }).gated).toBe(true);
  });
});

describe("gate — un-gradeable", () => {
  it("warns (passes) by default", () => {
    const r = gate({ grade: null, source: "ungradeable" });
    expect(r.gated).toBe(false);
    expect(r.reason).toMatch(/could not be graded/i);
  });
  it("fails under strict", () => {
    expect(gate({ grade: null, source: "ungradeable" }, { strict: true }).gated).toBe(true);
  });
});
