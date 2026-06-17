import { describe, it, expect } from "vitest";
import { AbiCoder } from "ethers";
import { encodeLitmusAttestation, decodeLitmusAttestation, litmusFields, LITMUS_SCHEMA } from "./eas.js";
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
    expect(f.resolvedVersion).toBe("1.2.3");
    expect(typeof f.ranAt).toBe("bigint");
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

  // Asserts the REAL eas-sdk SchemaEncoder (used by encodeLitmusAttestation and
  // the live mint flow) produces byte-identical output to a plain AbiCoder for
  // this flat schema — pinning the on-chain ABI layout against authentic bytes.
  // Retires the onchain-proof-spec §8 [verify] on the EAS ABI layout.
  it("SchemaEncoder output is byte-identical to AbiCoder (pins the EAS ABI layout)", () => {
    const cid = "ipfs://bafyCID";
    const f = litmusFields(bundle, cid);
    const viaSdk = encodeLitmusAttestation(bundle, cid); // real eas-sdk SchemaEncoder
    const viaAbi = AbiCoder.defaultAbiCoder().encode(
      ["string", "bytes32", "uint8", "uint8", "uint8", "string", "string", "string", "uint64", "string"],
      [f.serverRef, f.toolDefsFingerprint, f.gradeC01, f.gradeC02, f.gradeC03, f.overallGrade, f.reportCID, f.methodologyVersion, f.ranAt, f.resolvedVersion],
    );
    expect(viaSdk).toBe(viaAbi);
    // sanity: the schema string the SchemaEncoder is built from matches those types/order
    expect(LITMUS_SCHEMA).toContain("string serverRef");
    expect(LITMUS_SCHEMA).toContain("uint64 ranAt");
    expect(LITMUS_SCHEMA).toContain("string resolvedVersion");
  });
});
