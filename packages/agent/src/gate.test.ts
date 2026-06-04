import { describe, it, expect } from "vitest";
import { gateDecision, type LiveTarget } from "./gate.js";

const FP = "0x" + "ab".repeat(32);
const REF = "npm/@scope/server";
const live = (fingerprint: string, serverRef = REF): LiveTarget => ({ fingerprint, serverRef });

describe("gateDecision", () => {
  it("refuses when there is no attestation", () => {
    expect(gateDecision(null, live(FP)).action).toBe("refuse");
  });

  it("refuses a rug pull — live fingerprint differs from the attested one", () => {
    const d = gateDecision({ serverRef: REF, toolDefsFingerprint: FP, overallGrade: "A" }, live("0x" + "cd".repeat(32)));
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/rug pull/);
  });

  it("refuses an attestation minted over a DIFFERENT server (server-ref binding)", () => {
    const d = gateDecision(
      { serverRef: "npm/@scope/other", toolDefsFingerprint: FP, overallGrade: "A" },
      live(FP, REF),
    );
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/different server/);
  });

  it("refuses a failing grade even when the fingerprint matches", () => {
    expect(gateDecision({ serverRef: REF, toolDefsFingerprint: FP, overallGrade: "F" }, live(FP)).action).toBe("refuse");
    expect(gateDecision({ serverRef: REF, toolDefsFingerprint: FP, overallGrade: "D" }, live(FP)).action).toBe("refuse");
  });

  it("refuses a revoked attestation", () => {
    expect(
      gateDecision({ serverRef: REF, toolDefsFingerprint: FP, overallGrade: "A", revoked: true }, live(FP)).action,
    ).toBe("refuse");
  });

  it("refuses an expired attestation", () => {
    const d = gateDecision(
      { serverRef: REF, toolDefsFingerprint: FP, overallGrade: "A", expirationTime: 1000n },
      live(FP),
      undefined,
      null,
      2000n,
    );
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/expired/);
  });

  it("refuses when the bond was slashed on-chain (grade disproven, no arbiter)", () => {
    const d = gateDecision({ serverRef: REF, toolDefsFingerprint: FP, overallGrade: "A" }, live(FP), undefined, {
      bondSlashed: true,
    });
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/bond slashed/);
  });

  it("pays when ref + fingerprint match and the grade passes (case-insensitive)", () => {
    expect(gateDecision({ serverRef: REF, toolDefsFingerprint: FP, overallGrade: "A" }, live(FP)).action).toBe("pay");
    expect(
      gateDecision({ serverRef: REF, toolDefsFingerprint: FP.toUpperCase(), overallGrade: "B" }, live(FP)).action,
    ).toBe("pay");
  });
});
