/**
 * Read a SKILL attestation from chain. Mirrors read.ts, but fail-closes on the
 * SKILL schema UID (NEXT_PUBLIC_EAS_SKILL_SCHEMA_UID) — a SEPARATE UID from the
 * server schema. EAS schemas are permissionless, so without this bind a server
 * attestation (or a look-alike) could be decoded and trusted as a skill grade.
 *
 * The trust anchor a consumer must check is `contentHash`: recompute sha256 of the
 * skill directory (every file the SKILL.md can load) and require equality before
 * installing. There is no live re-fingerprint, so the (immutable) `resolvedRef`
 * pin and the contentHash are all that bind a grade to the bytes that run.
 */

import { Contract, JsonRpcProvider, ZeroHash } from "ethers";
import { CATEGORY_STATUS_UINT8, type CategoryStatus } from "@polygraph/core";
import { decodeSkillAttestation } from "./eas-skill.js";
import { networkConfig, rpcUrl } from "./networks.js";

/** Inverse of the on-chain uint8 verdict encoding (eas-skill.ts). Unknown →
 *  "skipped" (fail-safe: an unrecognized code is "not verified", never "pass"). */
function uint8ToCategoryStatus(n: number): CategoryStatus {
  return (Object.keys(CATEGORY_STATUS_UINT8) as CategoryStatus[]).find((k) => CATEGORY_STATUS_UINT8[k] === n) ?? "skipped";
}

// Same minimal EAS `getAttestation(bytes32)` fragment as read.ts.
const EAS_ABI = [
  "function getAttestation(bytes32 uid) view returns (" +
    "(bytes32 uid," +
    " bytes32 schema," +
    " uint64 time," +
    " uint64 expirationTime," +
    " uint64 revocationTime," +
    " bytes32 refUID," +
    " address recipient," +
    " address attester," +
    " bool revocable," +
    " bytes data))",
] as const;

interface EasAttestation {
  uid: string;
  schema: string;
  revocationTime: bigint;
  expirationTime: bigint;
  attester: string;
  data: string;
}
type EasReader = Contract & { getAttestation(uid: string): Promise<EasAttestation> };

/** The registered SKILL schema UID for the selected network (from env). Distinct
 *  from the server schema UID so the two can never be confused. */
export function skillSchemaUID(): string {
  const uid = process.env.NEXT_PUBLIC_EAS_SKILL_SCHEMA_UID;
  if (!uid) throw new Error("NEXT_PUBLIC_EAS_SKILL_SCHEMA_UID is required — register the skill schema first.");
  return uid;
}

export interface OnchainSkillAttestation {
  uid: string;
  skillRef: string;
  /** Whole-directory sha256 (`0x` + 64 hex) — the consumer's re-hash trust anchor. */
  contentHash: string;
  overallGrade: string;
  /** keccak256 of the canonical skill evidence bundle (`0x` + 64 hex). */
  evidenceHash: string;
  /** Public skill evidence page the hash can be checked against. */
  evidenceURI: string;
  /** Per-category verdicts decoded from the on-chain uint8 slots. A category that
   *  did not exist in this grade's methodology version reads as "skipped". */
  categories: {
    s01: CategoryStatus;
    s03: CategoryStatus;
    s04: CategoryStatus;
  };
  /** Immutable content pin (commit sha / contentHash) the grade was run against;
   *  null when none (the on-chain empty-string sentinel is normalized here). */
  resolvedRef: string | null;
  revoked: boolean;
  attester: string;
  expirationTime: bigint;
}

export async function readSkillAttestation(uid: string): Promise<OnchainSkillAttestation | null> {
  const cfg = networkConfig();
  const provider = new JsonRpcProvider(rpcUrl(), cfg.chainId);
  const eas = new Contract(cfg.eas, EAS_ABI, provider) as EasReader;

  const att = await eas.getAttestation(uid);
  if (!att || att.uid === ZeroHash) return null;

  // Bind to the SKILL schema (fail-closed): a non-skill schema is treated as no
  // attestation, so a server grade can never be read as a skill grade.
  if (String(att.schema).toLowerCase() !== skillSchemaUID().toLowerCase()) return null;

  const d = decodeSkillAttestation(att.data);
  return {
    uid: att.uid,
    skillRef: String(d.skillRef),
    contentHash: String(d.contentHash),
    overallGrade: String(d.overallGrade),
    evidenceHash: String(d.evidenceHash),
    evidenceURI: String(d.evidenceURI),
    categories: {
      s01: uint8ToCategoryStatus(Number(d.gradeS01)),
      s03: uint8ToCategoryStatus(Number(d.gradeS03)),
      s04: uint8ToCategoryStatus(Number(d.gradeS04)),
    },
    resolvedRef: (d.resolvedRef as string) || null,
    revoked: att.revocationTime > 0n,
    attester: String(att.attester),
    expirationTime: BigInt(att.expirationTime ?? 0n),
  };
}
