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

  // Asserts the REAL eas-sdk SchemaEncoder (used by encodeLitmusAttestation and
  // the live mint flow) produces byte-identical output to a plain AbiCoder for
  // this flat schema — pinning the on-chain ABI layout against authentic bytes.
  // Retires the onchain-proof-spec §8 [verify] on the EAS ABI layout.
  it("SchemaEncoder output is byte-identical to AbiCoder (pins the EAS ABI layout)", () => {
    const cid = "ipfs://bafyCID";
    const f = litmusFields(bundle, cid);
    const viaSdk = encodeLitmusAttestation(bundle, cid); // real eas-sdk SchemaEncoder
    const viaAbi = AbiCoder.defaultAbiCoder().encode(
      ["string", "bytes32", "uint8", "uint8", "uint8", "string", "string", "string", "uint64"],
      [f.serverRef, f.toolDefsFingerprint, f.gradeC01, f.gradeC02, f.gradeC03, f.overallGrade, f.reportCID, f.methodologyVersion, f.ranAt],
    );
    expect(viaSdk).toBe(viaAbi);
    // sanity: the schema string the SchemaEncoder is built from matches those types/order
    expect(LITMUS_SCHEMA).toContain("string serverRef");
    expect(LITMUS_SCHEMA).toContain("uint64 ranAt");
  });
});
