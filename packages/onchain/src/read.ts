/**
 * Read a litmus attestation from chain (the trust-critical read — onchain-proof
 * §7). Needs an RPC + a registered schema; the agent-gate calls this, then
 * re-checks the live fingerprint before paying.
 *
 * The read is a single EAS `getAttestation` view call. We hit the contract
 * directly through a minimal ethers ABI fragment (below) rather than the
 * eas-sdk `EAS` class — same on-chain struct, one fewer dependency (eas-sdk
 * dragged hardhat into the production tree).
 */

import { Contract, JsonRpcProvider, ZeroHash } from "ethers";
import { CATEGORY_STATUS_UINT8, type CategoryStatus } from "@polygraph/core";
import { decodeLitmusAttestation } from "./eas.js";
import { networkConfig, rpcUrl } from "./networks.js";

/** Inverse of the on-chain uint8 verdict encoding (eas.ts). Unknown → "skipped"
 *  (fail-safe: an unrecognized code is treated as "not verified", never "pass"). */
function uint8ToCategoryStatus(n: number): CategoryStatus {
  return (Object.keys(CATEGORY_STATUS_UINT8) as CategoryStatus[]).find((k) => CATEGORY_STATUS_UINT8[k] === n) ?? "skipped";
}

// EAS `getAttestation(bytes32)` → the on-chain `Attestation` struct (field order
// per the deployed EAS contract). Named tuple components give ethers v6 named
// accessors (att.uid / att.schema / att.data / att.attester / att.revocationTime
// / att.expirationTime), matching what EAS.getAttestation returned.
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

// The subset of the EAS `Attestation` struct this read consumes. ethers v6
// returns the tuple as a Result with these named accessors; typing the method
// (a string-ABI Contract is otherwise dynamically typed) is what `att.<field>`
// reads below rely on.
interface EasAttestation {
  uid: string;
  schema: string;
  revocationTime: bigint;
  expirationTime: bigint;
  attester: string;
  data: string;
}
type EasReader = Contract & { getAttestation(uid: string): Promise<EasAttestation> };

/** The registered litmus schema UID for the selected network (from env). */
export function litmusSchemaUID(): string {
  const uid = process.env.NEXT_PUBLIC_EAS_SCHEMA_UID;
  if (!uid) throw new Error("NEXT_PUBLIC_EAS_SCHEMA_UID is required — register the schema first.");
  return uid;
}

export interface OnchainLitmusAttestation {
  uid: string;
  serverRef: string;
  toolDefsFingerprint: string;
  overallGrade: string;
  /** keccak256 of the canonical evidence bundle (`0x` + 64 hex) — re-hash the
   *  published evidence and require equality to confirm the grade was not altered. */
  evidenceHash: string;
  /** Version-pinned public evidence page the hash can be checked against. */
  evidenceURI: string;
  /** The version the grade was run against; null for HTTP/unresolved targets
   *  (the on-chain empty-string sentinel is normalized to null here). */
  resolvedVersion: string | null;
  revoked: boolean;
  /** Account that signed the attestation (self-mint model: any address). */
  attester: string;
  /** The litmus methodology version this grade was produced under — signed,
   *  on-chain data (the gate can require a known/accepted version). */
  methodologyVersion: string;
  /** Per-category verdicts decoded from the on-chain uint8 slots. A category that
   *  did not exist in this grade's methodology version reads as "skipped"
   *  (disambiguate by methodologyVersion). */
  categories: {
    c01: CategoryStatus;
    c02: CategoryStatus;
    c03: CategoryStatus;
    c04: CategoryStatus;
  };
  /** True only when the C-02 egress probe actually ran AND passed. False for
   *  remote or no-sandbox grades, where egress was skipped: such a grade caps
   *  at B but its network behavior was never observed, so a payment gate should
   *  not treat it like an egress-clean local A. */
  egressVerified: boolean;
  /** EAS expiry in unix seconds; 0n = no expiration. */
  expirationTime: bigint;
}

export async function readAttestation(uid: string): Promise<OnchainLitmusAttestation | null> {
  const cfg = networkConfig();
  const provider = new JsonRpcProvider(rpcUrl(), cfg.chainId);
  const eas = new Contract(cfg.eas, EAS_ABI, provider) as EasReader;

  const att = await eas.getAttestation(uid);
  if (!att || att.uid === ZeroHash) return null;

  // Bind to OUR schema. EAS schemas are permissionless: anyone can register an
  // identically-shaped schema and mint a "grade A" under it. Without this check a
  // forged attestation under a look-alike schema would decode cleanly and be
  // trusted. Treat a non-litmus schema as no attestation (fail-closed).
  if (String(att.schema).toLowerCase() !== litmusSchemaUID().toLowerCase()) return null;

  const d = decodeLitmusAttestation(att.data);
  return {
    uid: att.uid,
    serverRef: String(d.serverRef),
    toolDefsFingerprint: String(d.toolDefsFingerprint),
    overallGrade: String(d.overallGrade),
    evidenceHash: String(d.evidenceHash),
    evidenceURI: String(d.evidenceURI),
    resolvedVersion: (d.resolvedVersion as string) || null,
    revoked: att.revocationTime > 0n,
    attester: String(att.attester),
    methodologyVersion: String(d.methodologyVersion),
    categories: {
      c01: uint8ToCategoryStatus(Number(d.gradeC01)),
      c02: uint8ToCategoryStatus(Number(d.gradeC02)),
      c03: uint8ToCategoryStatus(Number(d.gradeC03)),
      c04: uint8ToCategoryStatus(Number(d.gradeC04)),
    },
    egressVerified: uint8ToCategoryStatus(Number(d.gradeC02)) === "pass",
    expirationTime: BigInt(att.expirationTime ?? 0n),
  };
}
