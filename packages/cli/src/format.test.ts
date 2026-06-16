import { describe, it, expect } from "vitest";
import { formatBundle } from "./format.js";
import type { EvidenceBundle } from "@polygraph/core";

const base: EvidenceBundle = {
  schemaVersion: "1.1.0",
  methodologyVersion: "litmus-v3",
  serverRef: "npm/@scope/server",
  resolvedVersion: "1.2.3",
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
});
