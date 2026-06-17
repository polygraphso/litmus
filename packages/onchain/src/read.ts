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
import { decodeLitmusAttestation } from "./eas.js";
import { networkConfig, rpcUrl } from "./networks.js";

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
  reportCID: string;
  /** The version the grade was run against; null for HTTP/unresolved targets
   *  (the on-chain empty-string sentinel is normalized to null here). */
  resolvedVersion: string | null;
  revoked: boolean;
  /** Account that signed the attestation (self-mint model: any address). */
  attester: string;
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
    reportCID: String(d.reportCID),
    resolvedVersion: (d.resolvedVersion as string) || null,
    revoked: att.revocationTime > 0n,
    attester: String(att.attester),
    expirationTime: BigInt(att.expirationTime ?? 0n),
  };
}
