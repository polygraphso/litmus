import { describe, it, expect } from "vitest";
import { AbiCoder, keccak256 } from "ethers";
import type { EvidenceBundle } from "@polygraph/core";
import { staticCoreFields, staticCoreDigest, reRunCommitment, BondStatus } from "./bond.js";

const FP = "0x" + "ab".repeat(32);

function bundleWith(opts: { c01: "pass" | "fail"; leak: boolean }): EvidenceBundle {
  return {
    schemaVersion: "1.0.0",
    methodologyVersion: "litmus-v1",
    serverRef: "npm/@scope/server",
    resolvedVersion: "1.2.3",
    target: { kind: "stdio", command: "npx -y @scope/server", url: null },
    toolDefsFingerprint: FP,
    toolDefs: [],
    ranAt: "2026-06-03T15:04:05Z",
    harness: { package: "@polygraph/probes", version: "0.0.0", node: "v22", dockerAvailable: true },
    categories: [
      { code: "C-01", status: opts.c01, probes: [] },
      { code: "C-02", status: "pass", probes: [] },
      {
        code: "C-03",
        status: opts.leak ? "fail" : "pass",
        probes: [
          { id: "4.1", status: opts.leak ? "fail" : "pass", findings: [] },
          { id: "4.2", status: "pass", findings: [] },
        ],
      },
    ],
    grade: opts.c01 === "fail" || opts.leak ? "F" : "A",
    gradeRationale: "",
    disclaimer: "",
  };
}

describe("PolygraphBond static-core interop", () => {
  it("extracts the anywhere-deterministic core (fingerprint, C-01 uint8, probe-4.1 leak)", () => {
    expect(staticCoreFields(bundleWith({ c01: "pass", leak: false }))).toEqual({
      fingerprint: FP,
      c01: 0,
      outputLeak: false,
    });
    expect(staticCoreFields(bundleWith({ c01: "fail", leak: false }))).toMatchObject({ c01: 1 });
    expect(staticCoreFields(bundleWith({ c01: "pass", leak: true }))).toMatchObject({ outputLeak: true });
  });

  it("digest/commitment encodings match the contract's keccak(abi.encode(...))", () => {
    const abi = AbiCoder.defaultAbiCoder();
    const core = { fingerprint: FP, c01: 1, outputLeak: false };
    const salt = "0x" + "22".repeat(32);

    // Same encoding PolygraphBond.revealRerun / commitRerun use.
    expect(staticCoreDigest(core)).toBe(
      keccak256(abi.encode(["bytes32", "uint8", "bool"], [FP, 1, false])),
    );
    expect(reRunCommitment(core, salt)).toBe(
      keccak256(abi.encode(["bytes32", "uint8", "bool", "bytes32"], [FP, 1, false, salt])),
    );
    // commitment binds the salt — different salt, different commitment, same digest.
    expect(reRunCommitment(core, "0x" + "33".repeat(32))).not.toBe(reRunCommitment(core, salt));
  });

  it("exposes the contract's Status enum", () => {
    expect(BondStatus.Slashed).toBe(3);
    expect(BondStatus.Cleared).toBe(5);
  });
});
