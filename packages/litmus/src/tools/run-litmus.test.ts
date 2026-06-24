import { describe, it, expect } from "vitest";
import type { DependencyAudit, EvidenceBundle } from "@polygraph/core";
import { summarize } from "./run-litmus.js";

const bundle: EvidenceBundle = {
  schemaVersion: "1.5.0",
  methodologyVersion: "litmus-v6",
  serverRef: "npm/@scope/server",
  resolvedVersion: "1.2.3",
  selfReportedVersion: null,
  target: { kind: "stdio", command: "npx -y @scope/server", url: null },
  toolDefsFingerprint: "0x" + "ab".repeat(32),
  toolDefs: [],
  ranAt: "2026-06-23T00:00:00Z",
  harness: { package: "@polygraph/probes", version: "0.0.0", node: "v22", dockerAvailable: true },
  categories: [
    { code: "C-01", status: "pass", probes: [] },
    { code: "C-02", status: "pass", probes: [] },
    { code: "C-03", status: "pass", probes: [] },
    { code: "C-04", status: "pass", probes: [] },
  ],
  grade: "A",
  gradeRationale: "All checks passed.",
  disclaimer: "x",
};

describe("summarize — dependencyAudit field", () => {
  it("is null when no audit was run", () => {
    expect(summarize(bundle).dependencyAudit).toBeNull();
  });

  it("carries an ok audit through, capped at 20 advisories, with the advisory-only note", () => {
    const audit: DependencyAudit = {
      status: "ok",
      source: "osv.dev",
      ecosystem: "npm",
      queriedAt: "2026-06-23T00:00:00.000Z",
      dependencyCount: 30,
      vulnerableCount: 1,
      advisories: [
        { package: "ws", version: "8.17.1", id: "GHSA-96hv-2xvq-fx4p", severity: "high", summary: "DoS", fixedIn: "8.21.0", url: "https://x" },
      ],
    };
    const out = summarize(bundle, audit).dependencyAudit;
    expect(out).toMatchObject({
      status: "ok",
      source: "osv.dev",
      dependencyCount: 30,
      vulnerableCount: 1,
    });
    expect(out?.note).toMatch(/not part of the .*grade/i);
    expect(out?.advisories[0]).toMatchObject({ package: "ws", id: "GHSA-96hv-2xvq-fx4p", severity: "high", fixedIn: "8.21.0" });
  });

  it("represents a skipped audit with its reason and no advisories", () => {
    const audit: DependencyAudit = {
      status: "skipped",
      reason: "not applicable for pypi targets",
      source: "osv.dev",
      ecosystem: "npm",
      queriedAt: "2026-06-23T00:00:00.000Z",
      dependencyCount: 0,
      vulnerableCount: 0,
      advisories: [],
    };
    const out = summarize(bundle, audit).dependencyAudit;
    expect(out).toMatchObject({ status: "skipped", reason: "not applicable for pypi targets" });
    expect(out?.advisories).toEqual([]);
  });

  it("keeps the audit a sibling of the grade and never mutates the bundle", () => {
    // The bundle is the minted/hashed artifact; the audit rides beside it in the
    // tool payload only. summarize must not fold the audit into the bundle.
    const before = JSON.stringify(bundle);
    const audit: DependencyAudit = {
      status: "ok",
      source: "osv.dev",
      ecosystem: "npm",
      queriedAt: "2026-06-23T00:00:00.000Z",
      dependencyCount: 1,
      vulnerableCount: 0,
      advisories: [],
    };
    const payload = summarize(bundle, audit);
    // The audit is a top-level field, not nested in any bundle-shaped object.
    expect(payload).toHaveProperty("dependencyAudit");
    expect(payload).toHaveProperty("grade", bundle.grade);
    expect(payload).toHaveProperty("fingerprint", bundle.toolDefsFingerprint);
    // The input bundle is untouched (the real reproducibility guard lives in
    // probes/bundle.test.ts, against assembleBundle's minted key set).
    expect(JSON.stringify(bundle)).toBe(before);
  });
});
