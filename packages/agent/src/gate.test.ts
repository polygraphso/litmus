import { describe, it, expect } from "vitest";
import { gateDecision } from "./gate.js";

const FP = "0x" + "ab".repeat(32);

describe("gateDecision", () => {
  it("refuses when there is no attestation", () => {
    expect(gateDecision(null, FP).action).toBe("refuse");
  });

  it("refuses a rug pull — live fingerprint differs from the attested one", () => {
    const d = gateDecision({ toolDefsFingerprint: FP, overallGrade: "A" }, "0x" + "cd".repeat(32));
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/rug pull/);
  });

  it("refuses a failing grade even when the fingerprint matches", () => {
    expect(gateDecision({ toolDefsFingerprint: FP, overallGrade: "F" }, FP).action).toBe("refuse");
    expect(gateDecision({ toolDefsFingerprint: FP, overallGrade: "D" }, FP).action).toBe("refuse");
  });

  it("refuses a revoked attestation", () => {
    expect(gateDecision({ toolDefsFingerprint: FP, overallGrade: "A", revoked: true }, FP).action).toBe("refuse");
  });

  it("pays when the fingerprint matches and the grade passes (case-insensitive)", () => {
    expect(gateDecision({ toolDefsFingerprint: FP, overallGrade: "A" }, FP).action).toBe("pay");
    expect(gateDecision({ toolDefsFingerprint: FP.toUpperCase(), overallGrade: "B" }, FP).action).toBe("pay");
  });
});
