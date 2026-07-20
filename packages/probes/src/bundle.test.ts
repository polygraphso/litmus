import { describe, it, expect } from "vitest";
import { assembleBundle, type BundleInput } from "./bundle.js";

const input: BundleInput = {
  serverRef: "npm/@scope/server",
  resolvedVersion: "1.2.3",
  selfReportedVersion: null,
  target: { kind: "stdio", command: "npx -y @scope/server", url: null },
  toolDefsFingerprint: "0x" + "ab".repeat(32),
  toolDefs: [],
  categories: [{ code: "C-01", status: "pass", probes: [] }],
  grade: { grade: "A", rationale: "All checks passed." },
  ranAt: "2026-06-23T00:00:00Z",
  dockerAvailable: true,
};

describe("assembleBundle — minted/hashed shape", () => {
  it("emits exactly the EvidenceBundle keys, never the point-in-time dependency audit", () => {
    // The bundle is canonicalized → hashed → minted, so its key set is a
    // reproducibility contract: a time-varying field (e.g. the dependency audit)
    // must never leak in, or re-running the harness would yield a different CID.
    const keys = Object.keys(assembleBundle(input)).sort();
    expect(keys).toEqual(
      [
        "categories",
        "disclaimer",
        "grade",
        "gradeRationale",
        "harness",
        "methodologyVersion",
        "ranAt",
        "resolvedVersion",
        "schemaVersion",
        "selfReportedVersion",
        "serverRef",
        "target",
        "toolDefs",
        "toolDefsFingerprint",
      ].sort(),
    );
    expect(keys).not.toContain("dependencyAudit");
  });

  // litmus-v17: both new fields are optional and present only when supplied,
  // so the key-set contract above is unaffected when a caller omits them.
  it("omits presentedClientInfo and surfaceConsistency when not supplied", () => {
    const bundle = assembleBundle(input);
    expect(bundle.harness).not.toHaveProperty("presentedClientInfo");
    expect(bundle).not.toHaveProperty("surfaceConsistency");
  });

  it("records presentedClientInfo on the harness object when supplied", () => {
    const bundle = assembleBundle({ ...input, presentedClientInfo: { name: "claude-code", version: "2.1.0" } });
    expect(bundle.harness.presentedClientInfo).toEqual({ name: "claude-code", version: "2.1.0" });
  });

  it("records surfaceConsistency at the top level when supplied", () => {
    const finding = { kind: "surface-drift" as const, severity: "medium" as const, match: "drifted" };
    const bundle = assembleBundle({ ...input, surfaceConsistency: finding });
    expect(bundle.surfaceConsistency).toEqual(finding);
  });
});
