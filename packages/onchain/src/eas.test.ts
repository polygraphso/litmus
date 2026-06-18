import { describe, it, expect } from "vitest";
import { AbiCoder } from "ethers";
import { encodeLitmusAttestation, decodeLitmusAttestation, litmusFields, LITMUS_SCHEMA } from "./eas.js";
import type { EvidenceBundle } from "@polygraph/core";

const bundle: EvidenceBundle = {
  schemaVersion: "1.0.0",
  methodologyVersion: "litmus-v1",
  serverRef: "npm/@scope/server",
  resolvedVersion: "1.2.3",
  // Deliberately non-null and != resolvedVersion: the GOLDEN_ENCODED test below
  // re-encodes this exact bundle, so its byte-identical output proves
  // selfReportedVersion never reaches the on-chain attestation (off-chain only).
  selfReportedVersion: "9.9.9-self",
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

// Canonical EAS encoding of `bundle` (with reportCID "ipfs://bafyCID"), captured
// ONCE from the authentic @ethereum-attestation-service/eas-sdk SchemaEncoder
// before that dependency was removed. This pins our ethers-based encoder to the
// exact on-chain ABI bytes the SDK (and the web-app mint path) produce. Do NOT
// hand-edit — regenerate from the real SchemaEncoder if the schema or this
// fixture bundle ever changes.
const GOLDEN_ENCODED =
  "0x0000000000000000000000000000000000000000000000000000000000000140abababababababababababababababababababababababababababababababab000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000006a204265000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000000116e706d2f4073636f70652f73657276657200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e697066733a2f2f6261667943494400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000096c69746d75732d763100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005312e322e33000000000000000000000000000000000000000000000000000000";

describe("EAS litmus attestation", () => {
  it("maps category statuses to uint8 (0 pass, 1 fail, 2 skipped)", () => {
    const f = litmusFields(bundle, "ipfs://cid");
    expect(f.gradeC01).toBe(0);
    expect(f.gradeC02).toBe(2);
    expect(f.gradeC03).toBe(0);
    expect(f.overallGrade).toBe("B");
    expect(f.resolvedVersion).toBe("1.2.3");
    expect(typeof f.ranAt).toBe("bigint");
    // selfReportedVersion is descriptive metadata, never an on-chain field.
    expect(Object.keys(f)).not.toContain("selfReportedVersion");
  });

  it("encodes and decodes round-trip", () => {
    const encoded = encodeLitmusAttestation(bundle, "ipfs://bafyCID");
    expect(encoded).toMatch(/^0x[0-9a-f]+$/i);
    const dec = decodeLitmusAttestation(encoded);
    expect(dec.serverRef).toBe("npm/@scope/server");
    expect(dec.overallGrade).toBe("B");
    expect(dec.reportCID).toBe("ipfs://bafyCID");
    expect(dec.resolvedVersion).toBe("1.2.3");
    expect(String(dec.toolDefsFingerprint).toLowerCase()).toBe("0x" + "ab".repeat(32));
  });

  it("encodes a null resolvedVersion as the empty-string sentinel", () => {
    const encoded = encodeLitmusAttestation({ ...bundle, resolvedVersion: null }, "ipfs://cid");
    expect(decodeLitmusAttestation(encoded).resolvedVersion).toBe("");
  });

  // litmus-v4 / decision (b): C-04 is graded OFF-CHAIN. A bundle carrying a C-04
  // verdict must still encode to the unchanged 3-slot schema (no gradeC04), with
  // the C-04 outcome reflected only in overallGrade — so v4 attestations mint
  // under the existing schema UID and the agent gate needs no change.
  it("keeps the 3-slot schema for a litmus-v4 bundle carrying C-04 (no gradeC04)", () => {
    const v4: EvidenceBundle = {
      ...bundle,
      methodologyVersion: "litmus-v4",
      categories: [
        { code: "C-01", status: "pass", probes: [] },
        { code: "C-02", status: "pass", probes: [] },
        { code: "C-03", status: "pass", probes: [] },
        { code: "C-04", status: "fail", probes: [] },
      ],
      grade: "D",
    };
    const f = litmusFields(v4, "ipfs://cid");
    expect(Object.keys(f)).not.toContain("gradeC04"); // no 4th category slot
    expect(f.gradeC01).toBe(0);
    expect(f.gradeC03).toBe(0);
    expect(f.overallGrade).toBe("D"); // C-04 reflected in the letter, not a slot
    expect(f.methodologyVersion).toBe("litmus-v4");
    // The encoded ABI still has exactly the 3 uint8 category slots.
    expect((LITMUS_SCHEMA.match(/uint8/g) ?? []).length).toBe(3);
    const dec = decodeLitmusAttestation(encodeLitmusAttestation(v4, "ipfs://cid"));
    expect(dec.overallGrade).toBe("D");
    expect(dec.gradeC04).toBeUndefined();
  });

  // The production encoder is now ethers-based (eas-sdk removed). GOLDEN_ENCODED
  // was captured ONCE from the authentic eas-sdk SchemaEncoder, so this pins our
  // output to the exact on-chain ABI bytes the SDK (and the web-app mint path)
  // produce — any drift in field order/types/encoding fails here. Retires the
  // onchain-proof-spec §8 [verify] on the EAS ABI layout.
  it("encodes byte-identically to the authentic eas-sdk bytes (pins the EAS ABI layout)", () => {
    expect(encodeLitmusAttestation(bundle, "ipfs://bafyCID")).toBe(GOLDEN_ENCODED);
  });

  it("decodes the authentic eas-sdk bytes back to the expected fields", () => {
    const dec = decodeLitmusAttestation(GOLDEN_ENCODED);
    expect(dec.serverRef).toBe("npm/@scope/server");
    expect(dec.overallGrade).toBe("B");
    expect(dec.reportCID).toBe("ipfs://bafyCID");
    expect(dec.methodologyVersion).toBe("litmus-v1");
    expect(dec.resolvedVersion).toBe("1.2.3");
    expect(String(dec.toolDefsFingerprint).toLowerCase()).toBe("0x" + "ab".repeat(32));
  });

  // Independent cross-check: a plain AbiCoder with the explicit type/order list
  // reproduces the authentic bytes too, asserting LITMUS_SCHEMA's types/order
  // match what we encode against.
  it("AbiCoder with the explicit type list reproduces the authentic bytes", () => {
    const f = litmusFields(bundle, "ipfs://bafyCID");
    const viaAbi = AbiCoder.defaultAbiCoder().encode(
      ["string", "bytes32", "uint8", "uint8", "uint8", "string", "string", "string", "uint64", "string"],
      [f.serverRef, f.toolDefsFingerprint, f.gradeC01, f.gradeC02, f.gradeC03, f.overallGrade, f.reportCID, f.methodologyVersion, f.ranAt, f.resolvedVersion],
    );
    expect(viaAbi).toBe(GOLDEN_ENCODED);
    expect(LITMUS_SCHEMA).toContain("string serverRef");
    expect(LITMUS_SCHEMA).toContain("uint64 ranAt");
    expect(LITMUS_SCHEMA).toContain("string resolvedVersion");
  });
});
