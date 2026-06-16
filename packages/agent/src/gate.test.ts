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
      2000n,
    );
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/expired/);
  });

  it("pays when ref + fingerprint match and the grade passes (case-insensitive)", () => {
    expect(gateDecision({ serverRef: REF, toolDefsFingerprint: FP, overallGrade: "A" }, live(FP)).action).toBe("pay");
    expect(
      gateDecision({ serverRef: REF, toolDefsFingerprint: FP.toUpperCase(), overallGrade: "B" }, live(FP)).action,
    ).toBe("pay");
  });

  it("annotates the pay reason with the graded version when present", () => {
    const d = gateDecision({ serverRef: REF, toolDefsFingerprint: FP, overallGrade: "A", resolvedVersion: "1.2.3" }, live(FP));
    expect(d.action).toBe("pay");
    expect(d.reason).toMatch(/1\.2\.3/);
  });

  // The version is ADVISORY: there is no trustworthy live-version oracle, so the
  // version must NEVER change the action. This guards against anyone later adding
  // a refuse-on-version branch — the fingerprint stays the sole anchor.
  it("treats the version as advisory — it never changes the action", () => {
    const passing = { serverRef: REF, toolDefsFingerprint: FP, overallGrade: "A" as const };
    expect(gateDecision({ ...passing, resolvedVersion: "9.9.9" }, live(FP)).action).toBe("pay");
    expect(gateDecision({ ...passing, resolvedVersion: null }, live(FP)).action).toBe("pay");
    // a failing grade is still refused regardless of any version
    expect(gateDecision({ ...passing, overallGrade: "F", resolvedVersion: "1.2.3" }, live(FP)).action).toBe("refuse");
  });
});
