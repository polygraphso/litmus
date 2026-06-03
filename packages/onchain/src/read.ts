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
import { networkConfig } from "./networks.js";

export interface OnchainLitmusAttestation {
  uid: string;
  serverRef: string;
  toolDefsFingerprint: string;
  overallGrade: string;
  reportCID: string;
  revoked: boolean;
}

export async function readAttestation(uid: string): Promise<OnchainLitmusAttestation | null> {
  const cfg = networkConfig();
  const provider = new JsonRpcProvider(cfg.rpc, cfg.chainId);
  const eas = new EAS(cfg.eas);
  eas.connect(provider);

  const att = await eas.getAttestation(uid);
  if (!att || att.uid === ZeroHash) return null;

  const d = decodeLitmusAttestation(att.data);
  return {
    uid: att.uid,
    serverRef: String(d.serverRef),
    toolDefsFingerprint: String(d.toolDefsFingerprint),
    overallGrade: String(d.overallGrade),
    reportCID: String(d.reportCID),
    revoked: att.revocationTime > 0n,
  };
}
