/**
 * EAS attestation encoding for litmus grades (onchain-proof-spec §3).
 *
 * One schema, registered once per network; each litmus result is one attestation
 * referencing the bundle CID. The heavy evidence stays off-chain (pinned by
 * reportCID); on-chain we keep the fingerprint, per-category uint8 verdicts, the
 * letter grade, the methodology version, and the resolved version the grade was
 * run against (empty string when the target had no resolvable version).
 */

import { AbiCoder } from "ethers";
import {
  CATEGORY_STATUS_UINT8,
  METHODOLOGY_VERSION,
  type CategoryStatus,
  type EvidenceBundle,
} from "@polygraph/core";

// `resolvedVersion` is appended LAST so the ABI layout of the existing fields is
// unchanged. EAS strings can't be null, so the empty string is the "no version"
// sentinel (HTTP/unresolved targets); readers normalize "" → null.
export const LITMUS_SCHEMA =
  "string serverRef,bytes32 toolDefsFingerprint,uint8 gradeC01,uint8 gradeC02,uint8 gradeC03,string overallGrade,string reportCID,string methodologyVersion,uint64 ranAt,string resolvedVersion";

// Solidity types and field names in schema order — the single source the
// AbiCoder encodes/decodes against. For a FLAT schema (no nested tuples/arrays,
// no `bytes`/IPFS special-casing) the EAS SchemaEncoder is exactly
// `AbiCoder.defaultAbiCoder().encode(types, values)`, so we encode directly with
// ethers (already a dependency) and drop the heavyweight eas-sdk — which dragged
// hardhat into the production tree. `eas.test.ts` pins the output byte-for-byte
// against bytes captured from the authentic SchemaEncoder. If the schema ever
// gains a tuple/array/`bytes` field, this flat mapping no longer holds.
const LITMUS_ABI_TYPES = [
  "string", // serverRef
  "bytes32", // toolDefsFingerprint
  "uint8", // gradeC01
  "uint8", // gradeC02
  "uint8", // gradeC03
  "string", // overallGrade
  "string", // reportCID
  "string", // methodologyVersion
  "uint64", // ranAt
  "string", // resolvedVersion
] as const;
const LITMUS_ABI_NAMES = [
  "serverRef",
  "toolDefsFingerprint",
  "gradeC01",
  "gradeC02",
  "gradeC03",
  "overallGrade",
  "reportCID",
  "methodologyVersion",
  "ranAt",
  "resolvedVersion",
] as const;

export interface LitmusAttestationFields {
  serverRef: string;
  toolDefsFingerprint: string;
  gradeC01: number;
  gradeC02: number;
  gradeC03: number;
  overallGrade: string;
  reportCID: string;
  methodologyVersion: string;
  ranAt: bigint;
  resolvedVersion: string;
}

function categoryUint8(bundle: EvidenceBundle, code: string): number {
  const status = bundle.categories.find((c) => c.code === code)?.status as CategoryStatus | undefined;
  return status ? CATEGORY_STATUS_UINT8[status] : CATEGORY_STATUS_UINT8.skipped;
}

export function litmusFields(bundle: EvidenceBundle, reportCID: string): LitmusAttestationFields {
  // C-04 (adversarial input handling, litmus-v4) is graded OFF-CHAIN: it moves
  // the overall letter grade (a C-04 failure caps at D) and its full verdict is
  // in the evidence bundle (`categories[]`, referenced by reportCID), but the
  // schema keeps three per-category slots. The agent gate reads `overallGrade`,
  // not the per-category uint8s, so the grade already reflects C-04; adding a 4th
  // slot would force a schema re-registration (new UID) for no gate benefit.
  return {
    serverRef: bundle.serverRef,
    toolDefsFingerprint: bundle.toolDefsFingerprint,
    gradeC01: categoryUint8(bundle, "C-01"),
    gradeC02: categoryUint8(bundle, "C-02"),
    gradeC03: categoryUint8(bundle, "C-03"),
    overallGrade: bundle.grade,
    reportCID,
    methodologyVersion: bundle.methodologyVersion || METHODOLOGY_VERSION,
    ranAt: BigInt(Math.floor(Date.parse(bundle.ranAt) / 1000)),
    resolvedVersion: bundle.resolvedVersion ?? "",
  };
}

/** ABI-encode the attestation data for `eas.attest({ data })`. No network. */
export function encodeLitmusAttestation(bundle: EvidenceBundle, reportCID: string): string {
  const f = litmusFields(bundle, reportCID);
  return AbiCoder.defaultAbiCoder().encode(
    [...LITMUS_ABI_TYPES],
    [
      f.serverRef,
      f.toolDefsFingerprint,
      f.gradeC01,
      f.gradeC02,
      f.gradeC03,
      f.overallGrade,
      f.reportCID,
      f.methodologyVersion,
      f.ranAt,
      f.resolvedVersion,
    ],
  );
}

export function decodeLitmusAttestation(encoded: string): Record<string, unknown> {
  const values = AbiCoder.defaultAbiCoder().decode([...LITMUS_ABI_TYPES], encoded);
  const out: Record<string, unknown> = {};
  // Same runtime types the SchemaEncoder produced: uint8/uint64 → bigint,
  // bytes32 → lowercased hex, string → string. Downstream readers coerce with
  // String(...), so the field-by-field shape is unchanged.
  LITMUS_ABI_NAMES.forEach((name, i) => {
    out[name] = values[i];
  });
  return out;
}
