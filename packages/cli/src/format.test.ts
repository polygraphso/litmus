import { describe, it, expect } from "vitest";
import { formatBundle, formatDependencyAudit } from "./format.js";
import type { DependencyAudit, EvidenceBundle } from "@polygraph/core";

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

const auditBase: DependencyAudit = {
  status: "ok",
  source: "osv.dev",
  ecosystem: "npm",
  queriedAt: "2026-06-23T00:00:00.000Z",
  dependencyCount: 42,
  vulnerableCount: 2,
  advisories: [
    { package: "minimist", version: "1.2.0", id: "GHSA-vh95-rmgr-6w4m", severity: "critical", summary: "prototype pollution", fixedIn: "1.2.6", url: "https://x/1" },
    { package: "lodash", version: "4.17.15", id: "GHSA-p6mc-m468-83gw", severity: "moderate", summary: "prototype pollution", fixedIn: "4.17.19" },
  ],
};

describe("formatDependencyAudit", () => {
  it("labels the section point-in-time and not part of the grade", () => {
    const out = formatDependencyAudit(auditBase);
    expect(out).toMatch(/osv\.dev/);
    expect(out).toMatch(/not part of the grade|does not affect the .*grade/i);
  });

  it("summarizes the dependency and advisory counts", () => {
    const out = formatDependencyAudit(auditBase);
    expect(out).toMatch(/42/);
    expect(out).toMatch(/2 .*advisor/i);
  });

  it("lists each advisory with package, version, id, severity and fix", () => {
    const out = formatDependencyAudit(auditBase);
    expect(out).toMatch(/minimist@1\.2\.0/);
    expect(out).toContain("GHSA-vh95-rmgr-6w4m");
    expect(out).toMatch(/CRITICAL/i);
    expect(out).toMatch(/1\.2\.6/);
  });

  it("reports a clean tree without listing advisories", () => {
    const out = formatDependencyAudit({ ...auditBase, vulnerableCount: 0, advisories: [] });
    expect(out).toMatch(/no known advisories|0 .*advisor/i);
    expect(out).not.toContain("GHSA");
  });

  it("renders a skipped audit as a single reason line", () => {
    const out = formatDependencyAudit({
      ...auditBase,
      status: "skipped",
      reason: "not applicable for pypi targets",
      dependencyCount: 0,
      vulnerableCount: 0,
      advisories: [],
    });
    expect(out).toMatch(/skipped/i);
    expect(out).toMatch(/not applicable for pypi targets/);
    expect(out).not.toContain("GHSA");
  });
});
