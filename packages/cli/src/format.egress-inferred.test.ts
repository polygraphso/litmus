import { describe, it, expect } from "vitest";
import type { EvidenceBundle } from "@polygraph/core";
import { formatBundle } from "./format.js";

/** Minimal A-grade bundle whose C-02 2.2 carries an informational inferred-upstream finding. */
function bundleWithInferred(): EvidenceBundle {
  return {
    schemaVersion: "1.7.0",
    methodologyVersion: "litmus-v11",
    serverRef: "npm/openai-mcp",
    resolvedVersion: "1.0.0",
    selfReportedVersion: null,
    target: { kind: "stdio", command: "npx -y openai-mcp" },
    toolDefsFingerprint: "0x" + "0".repeat(64),
    toolDefs: [],
    ranAt: "2026-07-02T00:00:00.000Z",
    harness: { package: "@polygraphso/litmus", version: "0.0.0", node: "v22", dockerAvailable: true },
    categories: [
      { code: "C-01", status: "pass", probes: [] },
      {
        code: "C-02",
        status: "pass",
        probes: [
          { id: "2.1", status: "pass", findings: [] },
          {
            id: "2.2",
            status: "pass",
            findings: [
              { kind: "egress-inferred", severity: "low", match: "api.openai.com — inferred upstream (host-mention: api.openai.com)", host: "api.openai.com", port: 443 },
            ],
          },
        ],
      },
      { code: "C-03", status: "pass", probes: [] },
      { code: "C-04", status: "pass", probes: [] },
    ],
    grade: "A",
    gradeRationale: "All four categories passed.",
    disclaimer: "self-run",
  };
}

describe("formatBundle — inferred-upstream disclosure (litmus-v11)", () => {
  it("discloses inferred upstream hosts even on a passing grade", () => {
    const out = formatBundle(bundleWithInferred());
    expect(out).toContain("inferred upstream → api.openai.com");
    expect(out).toContain("polygraph.egress");
    // it is informational, not an "undeclared egress" failure line
    expect(out).not.toContain("undeclared egress → api.openai.com");
  });
});
