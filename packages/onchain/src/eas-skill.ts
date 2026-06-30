/**
 * EAS attestation encoding for SKILL grades (litmus-skill-v1).
 *
 * A SEPARATE, flat schema with its OWN UID — not an extension of LITMUS_SCHEMA.
 * read-skill.ts fail-closes any attestation not under this exact UID, so a skill
 * grade can never be read as a server grade (and vice versa). Fields mirror the
 * server schema but key on a static-content artifact: `skillRef` + `contentHash`
 * (the whole-directory hash) replace serverRef + toolDefsFingerprint, and
 * `resolvedRef` is the immutable content pin (commit sha / contentHash) the grade
 * was run against. Evidence is referenced by `evidenceHash` (bytes32) +
 * `evidenceURI` (string) — no IPFS.
 *
 * Like eas.ts, this is a FLAT schema (no tuples/arrays/dynamic bytes; `bytes32`
 * is fixed-size and inline), so the EAS SchemaEncoder reduces to
 * `AbiCoder.defaultAbiCoder().encode(types, values)`; we encode directly with
 * ethers and pin the bytes in eas-skill.test.ts.
 */

import { AbiCoder } from "ethers";
import { CATEGORY_STATUS_UINT8, type CategoryStatus } from "@polygraph/core";

// litmus-skill-v1 emits exactly three graded categories (S-01/S-03/S-04). S-02
// and S-05 are advisory-only (a static scan can't decide semantic honesty /
// permission overreach), so they are NOT pass/fail categories and have no slot;
// if either becomes a graded category, that is a NEW schema (new UID).
export const LITMUS_SKILL_SCHEMA =
  "string skillRef,bytes32 contentHash,uint8 gradeS01,uint8 gradeS03,uint8 gradeS04,string overallGrade,bytes32 evidenceHash,string evidenceURI,string methodologyVersion,uint64 ranAt,string resolvedRef";

const SKILL_ABI_TYPES = [
  "string", // skillRef
  "bytes32", // contentHash
  "uint8", // gradeS01
  "uint8", // gradeS03
  "uint8", // gradeS04
  "string", // overallGrade
  "bytes32", // evidenceHash
  "string", // evidenceURI
  "string", // methodologyVersion
  "uint64", // ranAt
  "string", // resolvedRef
] as const;
const SKILL_ABI_NAMES = [
  "skillRef",
  "contentHash",
  "gradeS01",
  "gradeS03",
  "gradeS04",
  "overallGrade",
  "evidenceHash",
  "evidenceURI",
  "methodologyVersion",
  "ranAt",
  "resolvedRef",
] as const;

export interface SkillAttestationFields {
  skillRef: string;
  contentHash: string;
  gradeS01: number;
  gradeS03: number;
  gradeS04: number;
  overallGrade: string;
  /** keccak256 of the canonical skill evidence bundle (`0x` + 64 hex). */
  evidenceHash: string;
  /** Public skill evidence page the hash can be checked against. */
  evidenceURI: string;
  methodologyVersion: string;
  ranAt: bigint;
  resolvedRef: string;
}

/** Minimal structural view of a skill evidence bundle — satisfied by the probes
 *  SkillEvidenceBundle, so onchain needs no dependency on probes. */
export interface SkillGradeForAttestation {
  skillRef: string;
  contentHash: string;
  categories: readonly { code: string; status: CategoryStatus }[];
  grade: string;
  methodologyVersion: string;
  ranAt: string;
}

function categoryUint8(g: SkillGradeForAttestation, code: string): number {
  const status = g.categories.find((c) => c.code === code)?.status;
  return status ? CATEGORY_STATUS_UINT8[status] : CATEGORY_STATUS_UINT8.skipped;
}

/** Build the attestation fields. `resolvedRef` is the immutable pin (commit sha /
 *  contentHash) the grade was run against; "" when none is known. */
export function skillAttestationFields(
  g: SkillGradeForAttestation,
  evidenceHash: string,
  evidenceURI: string,
  resolvedRef: string | null,
): SkillAttestationFields {
  return {
    skillRef: g.skillRef,
    contentHash: g.contentHash,
    gradeS01: categoryUint8(g, "S-01"),
    gradeS03: categoryUint8(g, "S-03"),
    gradeS04: categoryUint8(g, "S-04"),
    overallGrade: g.grade,
    evidenceHash,
    evidenceURI,
    methodologyVersion: g.methodologyVersion,
    ranAt: BigInt(Math.floor(Date.parse(g.ranAt) / 1000)),
    resolvedRef: resolvedRef ?? "",
  };
}

export function encodeSkillAttestationFields(f: SkillAttestationFields): string {
  return AbiCoder.defaultAbiCoder().encode(
    [...SKILL_ABI_TYPES],
    [
      f.skillRef,
      f.contentHash,
      f.gradeS01,
      f.gradeS03,
      f.gradeS04,
      f.overallGrade,
      f.evidenceHash,
      f.evidenceURI,
      f.methodologyVersion,
      f.ranAt,
      f.resolvedRef,
    ],
  );
}

export function encodeSkillAttestation(
  g: SkillGradeForAttestation,
  evidenceHash: string,
  evidenceURI: string,
  resolvedRef: string | null,
): string {
  return encodeSkillAttestationFields(skillAttestationFields(g, evidenceHash, evidenceURI, resolvedRef));
}

export function decodeSkillAttestation(encoded: string): Record<string, unknown> {
  const values = AbiCoder.defaultAbiCoder().decode([...SKILL_ABI_TYPES], encoded);
  const out: Record<string, unknown> = {};
  SKILL_ABI_NAMES.forEach((name, i) => {
    out[name] = values[i];
  });
  return out;
}
