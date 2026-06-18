import { describe, it, expect } from "vitest";
import type { SkillEvidenceBundle } from "@polygraph/probes";
import { formatSkillSafety } from "./format-skill.js";

const base: SkillEvidenceBundle = {
  schemaVersion: "1.0.0",
  methodologyVersion: "litmus-skill-v1",
  skillRef: "/skills/demo",
  contentHash: "0x" + "cd".repeat(32),
  ranAt: "2026-06-18T00:00:00Z",
  harness: { package: "@polygraph/probes", version: "0.0.0", node: "v22" },
  categories: [
    { code: "S-01", status: "pass", findings: [] },
    { code: "S-03", status: "pass", findings: [] },
    { code: "S-04", status: "pass", findings: [] },
  ],
  advisories: [],
  grade: "A",
  gradeRationale: "All skill categories passed.",
  disclaimer: "static scan only",
};

describe("formatSkillSafety", () => {
  it("labels each category with its plain-English name", () => {
    const out = formatSkillSafety(base);
    expect(out).toContain("prompt injection / context poisoning");
    expect(out).toContain("data-exfiltration instructions");
    expect(out).toContain("dangerous bundled commands");
  });

  it("describes what each category checks", () => {
    expect(formatSkillSafety(base)).toContain("whether the skill body tries to hijack the agent");
  });

  it("keeps the S-code and the status beside the label", () => {
    expect(formatSkillSafety(base)).toMatch(/S-01\s+prompt injection \/ context poisoning.*\bpass\b/);
  });

  it("still prints the grade line and the disclaimer", () => {
    const out = formatSkillSafety(base);
    expect(out).toMatch(/grade: A {2}\(litmus-skill-v1\)/);
    expect(out).toContain("static scan only");
  });
});
