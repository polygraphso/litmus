import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  encodeSkillAttestation,
  decodeSkillAttestation,
  skillAttestationFields,
  LITMUS_SKILL_SCHEMA,
  type SkillGradeForAttestation,
} from "./eas-skill.js";

const g: SkillGradeForAttestation = {
  skillRef: "github/anthropic/skills#pdf",
  contentHash: "0x" + "cd".repeat(32),
  categories: [
    { code: "S-01", status: "pass" },
    { code: "S-03", status: "pass" },
    { code: "S-04", status: "fail" },
  ],
  grade: "D",
  methodologyVersion: "litmus-skill-v1",
  ranAt: "2026-06-17T00:00:00Z",
};

// sha256 of the ABI-encoded bytes for `g` (reportCID "ipfs://bafySKILL",
// resolvedRef "a1b2c3d"). A short, transcribable regression pin: the encoder is
// the same ethers AbiCoder path eas.test.ts pins byte-for-byte against the
// authentic EAS SchemaEncoder, so this guards against field-order / type drift in
// the skill schema. Regenerate (sha256 of the encoding) if the schema changes.
const PINNED_SHA256 = "47a2b9fef7b3388df3735546e11f3e1f0f5a53ee9784272b7f8358f0b5bb89a5";

describe("eas-skill — flat ABI encoder", () => {
  it("encodes to the pinned on-chain bytes (sha256)", () => {
    const enc = encodeSkillAttestation(g, "ipfs://bafySKILL", "a1b2c3d");
    expect(createHash("sha256").update(enc).digest("hex")).toBe(PINNED_SHA256);
  });

  it("round-trips encode → decode", () => {
    const d = decodeSkillAttestation(encodeSkillAttestation(g, "ipfs://bafySKILL", "a1b2c3d"));
    expect(d.skillRef).toBe(g.skillRef);
    expect(d.overallGrade).toBe("D");
    expect(String(d.gradeS04)).toBe("1"); // fail
    expect(String(d.gradeS01)).toBe("0"); // pass
    expect(d.resolvedRef).toBe("a1b2c3d");
  });

  it("maps per-category status to uint8 (pass=0, fail=1, skipped=2)", () => {
    const f = skillAttestationFields(
      { ...g, categories: [{ code: "S-01", status: "skipped" }] },
      "ipfs://x",
      null,
    );
    expect(f.gradeS01).toBe(2); // S-01 skipped
    expect(f.gradeS03).toBe(2); // absent ⇒ skipped sentinel
    expect(f.resolvedRef).toBe(""); // null ⇒ empty sentinel
  });

  it("is a flat schema with its own field set (not the server schema)", () => {
    expect(LITMUS_SKILL_SCHEMA).toContain("string skillRef");
    expect(LITMUS_SKILL_SCHEMA).toContain("bytes32 contentHash");
    expect(LITMUS_SKILL_SCHEMA).not.toContain("toolDefsFingerprint");
  });
});
