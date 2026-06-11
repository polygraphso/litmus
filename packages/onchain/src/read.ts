/**
 * Read a litmus attestation from chain (the trust-critical read — onchain-proof
 * §7). Needs an RPC + a registered schema; the agent-gate calls this, then
 * re-checks the live fingerprint before paying.
 *
 * [verify] eas-sdk EAS.getAttestation return shape (uid / data / revocationTime).
 */

import { EAS } from "./eas-sdk.js";
import { JsonRpcProvider, ZeroHash } from "ethers";
import { decodeLitmusAttestation } from "./eas.js";
import { litmusSchemaUID } from "./attest.js";
import { networkConfig, rpcUrl } from "./networks.js";

export interface OnchainLitmusAttestation {
  uid: string;
  serverRef: string;
  toolDefsFingerprint: string;
  overallGrade: string;
  reportCID: string;
  revoked: boolean;
  /** Account that signed the attestation (self-mint model: any address). */
  attester: string;
  /** EAS expiry in unix seconds; 0n = no expiration. */
  expirationTime: bigint;
}

export async function readAttestation(uid: string): Promise<OnchainLitmusAttestation | null> {
  const cfg = networkConfig();
  const provider = new JsonRpcProvider(rpcUrl(), cfg.chainId);
  const eas = new EAS(cfg.eas);
  eas.connect(provider);

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
    revoked: att.revocationTime > 0n,
    attester: String(att.attester),
    expirationTime: BigInt(att.expirationTime ?? 0n),
  };
}
