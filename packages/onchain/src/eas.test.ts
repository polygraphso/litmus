import { describe, it, expect } from "vitest";
import { encodeLitmusAttestation, decodeLitmusAttestation, litmusFields } from "./eas.js";
import type { EvidenceBundle } from "@polygraph/core";

const bundle: EvidenceBundle = {
  schemaVersion: "1.0.0",
  methodologyVersion: "litmus-v1",
  serverRef: "npm/@scope/server",
  resolvedVersion: "1.2.3",
  target: { kind: "stdio", command: "npx -y @scope/server", url: null },
  toolDefsFingerprint: "0x" + "ab".repeat(32),
  toolDefs: [],
  ranAt: "2026-06-03T15:04:05Z",
  harness: { package: "@polygraph/probes", version: "0.0.0", node: "v22", dockerAvailable: false },
  categories: [
    { code: "C-01", status: "pass", probes: [] },
    { code: "C-02", status: "skipped", probes: [] },
    { code: "C-03", status: "pass", probes: [] },
  ],
  grade: "B",
  gradeRationale: "Injection checks passed; egress not verified.",
  disclaimer: "Self-run, self-minted under litmus-v1.",
};

describe("EAS litmus attestation", () => {
  it("maps category statuses to uint8 (0 pass, 1 fail, 2 skipped)", () => {
    const f = litmusFields(bundle, "ipfs://cid");
    expect(f.gradeC01).toBe(0);
    expect(f.gradeC02).toBe(2);
    expect(f.gradeC03).toBe(0);
    expect(f.overallGrade).toBe("B");
    expect(typeof f.ranAt).toBe("bigint");
  });

  it("encodes and decodes round-trip", () => {
    const encoded = encodeLitmusAttestation(bundle, "ipfs://bafyCID");
    expect(encoded).toMatch(/^0x[0-9a-f]+$/i);
    const dec = decodeLitmusAttestation(encoded);
    expect(dec.serverRef).toBe("npm/@scope/server");
    expect(dec.overallGrade).toBe("B");
    expect(dec.reportCID).toBe("ipfs://bafyCID");
    expect(String(dec.toolDefsFingerprint).toLowerCase()).toBe("0x" + "ab".repeat(32));
  });
});
