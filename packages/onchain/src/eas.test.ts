import { describe, it, expect } from "vitest";
import { AbiCoder } from "ethers";
import { encodeLitmusAttestation, decodeLitmusAttestation, litmusFields, LITMUS_SCHEMA } from "./eas.js";
import type { EvidenceBundle } from "@polygraph/core";

// Evidence reference (no IPFS): a bytes32 keccak256 of the canonical bundle plus
// the version-pinned public evidence page URL. The minter computes the hash and
// passes both; the schema carries them in place of the old reportCID.
const EVIDENCE_HASH = "0x" + "ef".repeat(32);
const EVIDENCE_URI = "https://polygraph.so/grade/npm/@scope/server?v=1.2.3";

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
    // No C-04 in this (litmus-v1) bundle: an absent category encodes as the
    // skipped sentinel (2) — so old grades from before a category existed read
    // as "not evaluated", disambiguated by methodologyVersion.
  ],
  grade: "B",
  gradeRationale: "Injection checks passed; egress not verified.",
  disclaimer: "Self-run, self-minted under litmus-v1.",
};

// Canonical EAS encoding of `bundle` (gradeC04 absent → 2, evidenceHash 0xef…ef,
// evidenceURI the version-pinned /grade page), captured from the authentic
// @ethereum-attestation-service/eas-sdk SchemaEncoder (run from the web app,
// which still has the SDK). This pins our ethers-based encoder to the exact
// on-chain ABI bytes the SDK (and the web-app mint path) produce. Do NOT
// hand-edit — regenerate from the real SchemaEncoder if the schema or this
// fixture bundle ever changes.
const GOLDEN_ENCODED =
  "0x0000000000000000000000000000000000000000000000000000000000000180abababababababababababababababababababababababababababababababab000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000001c0efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef00000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000006a20426500000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000000116e706d2f4073636f70652f73657276657200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003468747470733a2f2f706f6c7967726170682e736f2f67726164652f6e706d2f4073636f70652f7365727665723f763d312e322e3300000000000000000000000000000000000000000000000000000000000000000000000000000000000000096c69746d75732d763100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005312e322e33000000000000000000000000000000000000000000000000000000";

describe("EAS litmus attestation", () => {
  it("maps category statuses to uint8 (0 pass, 1 fail, 2 skipped)", () => {
    const f = litmusFields(bundle, EVIDENCE_HASH, EVIDENCE_URI);
    expect(f.gradeC01).toBe(0);
    expect(f.gradeC02).toBe(2);
    expect(f.gradeC03).toBe(0);
    expect(f.gradeC04).toBe(2); // absent in this v1 bundle ⇒ skipped sentinel
    expect(f.overallGrade).toBe("B");
    expect(f.evidenceHash).toBe(EVIDENCE_HASH);
    expect(f.evidenceURI).toBe(EVIDENCE_URI);
    expect(f.resolvedVersion).toBe("1.2.3");
    expect(typeof f.ranAt).toBe("bigint");
    // selfReportedVersion is descriptive metadata, never an on-chain field.
    expect(Object.keys(f)).not.toContain("selfReportedVersion");
  });

  it("encodes and decodes round-trip", () => {
    const encoded = encodeLitmusAttestation(bundle, EVIDENCE_HASH, EVIDENCE_URI);
    expect(encoded).toMatch(/^0x[0-9a-f]+$/i);
    const dec = decodeLitmusAttestation(encoded);
    expect(dec.serverRef).toBe("npm/@scope/server");
    expect(dec.overallGrade).toBe("B");
    expect(String(dec.evidenceHash).toLowerCase()).toBe(EVIDENCE_HASH);
    expect(dec.evidenceURI).toBe(EVIDENCE_URI);
    expect(dec.resolvedVersion).toBe("1.2.3");
    expect(String(dec.toolDefsFingerprint).toLowerCase()).toBe("0x" + "ab".repeat(32));
  });

  it("encodes a null resolvedVersion as the empty-string sentinel", () => {
    const encoded = encodeLitmusAttestation({ ...bundle, resolvedVersion: null }, EVIDENCE_HASH, EVIDENCE_URI);
    expect(decodeLitmusAttestation(encoded).resolvedVersion).toBe("");
  });

  // C-04 (adversarial-input handling, litmus-v4) is encoded ON-CHAIN as the 4th
  // per-category uint8 slot — a C-04 verdict is now queryable, not only folded
  // into overallGrade. A v4 bundle whose C-04 failed encodes gradeC04=1 and a
  // grade capped at D.
  it("encodes C-04 as the 4th per-category slot for a litmus-v4 bundle", () => {
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
    const f = litmusFields(v4, EVIDENCE_HASH, EVIDENCE_URI);
    expect(f.gradeC01).toBe(0);
    expect(f.gradeC03).toBe(0);
    expect(f.gradeC04).toBe(1); // C-04 fail, now an on-chain slot
    expect(f.overallGrade).toBe("D"); // C-04 also caps the letter
    expect(f.methodologyVersion).toBe("litmus-v4");
    // The schema now carries exactly the 4 uint8 category slots.
    expect((LITMUS_SCHEMA.match(/uint8/g) ?? []).length).toBe(4);
    const dec = decodeLitmusAttestation(encodeLitmusAttestation(v4, EVIDENCE_HASH, EVIDENCE_URI));
    expect(dec.overallGrade).toBe("D");
    expect(String(dec.gradeC04)).toBe("1");
  });

  // GOLDEN_ENCODED was captured from the authentic eas-sdk SchemaEncoder, so this
  // pins our ethers output to the exact on-chain ABI bytes the SDK (and the
  // web-app mint path) produce — any drift in field order/types/encoding fails here.
  it("encodes byte-identically to the authentic eas-sdk bytes (pins the EAS ABI layout)", () => {
    expect(encodeLitmusAttestation(bundle, EVIDENCE_HASH, EVIDENCE_URI)).toBe(GOLDEN_ENCODED);
  });

  it("decodes the authentic eas-sdk bytes back to the expected fields", () => {
    const dec = decodeLitmusAttestation(GOLDEN_ENCODED);
    expect(dec.serverRef).toBe("npm/@scope/server");
    expect(dec.overallGrade).toBe("B");
    expect(String(dec.evidenceHash).toLowerCase()).toBe(EVIDENCE_HASH);
    expect(dec.evidenceURI).toBe(EVIDENCE_URI);
    expect(dec.methodologyVersion).toBe("litmus-v1");
    expect(dec.resolvedVersion).toBe("1.2.3");
    expect(String(dec.toolDefsFingerprint).toLowerCase()).toBe("0x" + "ab".repeat(32));
  });

  // Independent cross-check: a plain AbiCoder with the explicit type/order list
  // reproduces the authentic bytes too, asserting LITMUS_SCHEMA's types/order
  // match what we encode against.
  it("AbiCoder with the explicit type list reproduces the authentic bytes", () => {
    const f = litmusFields(bundle, EVIDENCE_HASH, EVIDENCE_URI);
    const viaAbi = AbiCoder.defaultAbiCoder().encode(
      ["string", "bytes32", "uint8", "uint8", "uint8", "uint8", "string", "bytes32", "string", "string", "uint64", "string"],
      [f.serverRef, f.toolDefsFingerprint, f.gradeC01, f.gradeC02, f.gradeC03, f.gradeC04, f.overallGrade, f.evidenceHash, f.evidenceURI, f.methodologyVersion, f.ranAt, f.resolvedVersion],
    );
    expect(viaAbi).toBe(GOLDEN_ENCODED);
    expect(LITMUS_SCHEMA).toContain("string serverRef");
    expect(LITMUS_SCHEMA).toContain("uint8 gradeC04");
    expect(LITMUS_SCHEMA).toContain("bytes32 evidenceHash");
    expect(LITMUS_SCHEMA).toContain("string evidenceURI");
    expect(LITMUS_SCHEMA).toContain("uint64 ranAt");
    expect(LITMUS_SCHEMA).toContain("string resolvedVersion");
  });
});
