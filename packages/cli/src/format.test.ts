import { describe, it, expect } from "vitest";
import { formatBundle } from "./format.js";
import type { EvidenceBundle } from "@polygraph/core";

const base: EvidenceBundle = {
  schemaVersion: "1.3.0",
  methodologyVersion: "litmus-v4",
  serverRef: "npm/@scope/server",
  resolvedVersion: "1.2.3",
  selfReportedVersion: "0.9.9",
  target: { kind: "stdio", command: "npx -y @scope/server", url: null },
  toolDefsFingerprint: "0x" + "ab".repeat(32),
  toolDefs: [],
  ranAt: "2026-06-03T15:04:05Z",
  harness: { package: "@polygraph/probes", version: "0.0.0", node: "v22", dockerAvailable: true },
  categories: [
    { code: "C-01", status: "pass", probes: [] },
    { code: "C-02", status: "pass", probes: [] },
    { code: "C-03", status: "pass", probes: [] },
  ],
  grade: "A",
  gradeRationale: "All checks passed.",
  disclaimer: "x",
};

describe("formatBundle", () => {
  it("prints the resolved version when present", () => {
    expect(formatBundle(base)).toMatch(/→ version 1\.2\.3/);
  });

  it("omits the version line for an unresolved (HTTP/null) target", () => {
    const out = formatBundle({ ...base, resolvedVersion: null });
    expect(out).not.toMatch(/→ version/);
  });

  it("prints the server's self-reported version, marked unverified", () => {
    const out = formatBundle(base);
    expect(out).toMatch(/self-reported 0\.9\.9 \(unverified\)/);
  });

  it("omits the self-reported line when the server reports none", () => {
    const out = formatBundle({ ...base, selfReportedVersion: null });
    expect(out).not.toMatch(/self-reported/);
  });
});

describe("formatBundle — readable checks", () => {
  it("labels each category with its plain-English name", () => {
    const out = formatBundle(base);
    expect(out).toContain("tool-output injection");
    expect(out).toContain("permission / egress overreach");
    expect(out).toContain("sensitive-data handling");
  });

  it("describes what each category checks, beneath its label", () => {
    expect(formatBundle(base)).toContain("whether it tries to hijack the caller through tool output");
  });

  it("keeps the probe code and the status beside the label", () => {
    expect(formatBundle(base)).toMatch(/C-01\s+tool-output injection.*\bpass\b/);
  });

  it("drops the old code-only compact line", () => {
    expect(formatBundle(base)).not.toMatch(/C-01 pass · C-02/);
  });
});
