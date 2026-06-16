/**
 * EAS attestation encoding for litmus grades (onchain-proof-spec §3).
 *
 * One schema, registered once per network; each litmus result is one attestation
 * referencing the bundle CID. The heavy evidence stays off-chain (pinned by
 * reportCID); on-chain we keep the fingerprint, per-category uint8 verdicts, the
 * letter grade, the methodology version, and the resolved version the grade was
 * run against (empty string when the target had no resolvable version).
 */

import { SchemaEncoder } from "./eas-sdk.js";
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
  const enc = new SchemaEncoder(LITMUS_SCHEMA);
  return enc.encodeData([
    { name: "serverRef", value: f.serverRef, type: "string" },
    { name: "toolDefsFingerprint", value: f.toolDefsFingerprint, type: "bytes32" },
    { name: "gradeC01", value: f.gradeC01, type: "uint8" },
    { name: "gradeC02", value: f.gradeC02, type: "uint8" },
    { name: "gradeC03", value: f.gradeC03, type: "uint8" },
    { name: "overallGrade", value: f.overallGrade, type: "string" },
    { name: "reportCID", value: f.reportCID, type: "string" },
    { name: "methodologyVersion", value: f.methodologyVersion, type: "string" },
    { name: "ranAt", value: f.ranAt, type: "uint64" },
    { name: "resolvedVersion", value: f.resolvedVersion, type: "string" },
  ]);
}

export function decodeLitmusAttestation(encoded: string): Record<string, unknown> {
  const enc = new SchemaEncoder(LITMUS_SCHEMA);
  const out: Record<string, unknown> = {};
  for (const item of enc.decodeData(encoded)) {
    out[item.name] = item.value.value;
  }
  return out;
}
