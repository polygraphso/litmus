/**
 * Mint a litmus grade as an EAS attestation on Base (onchain-proof-spec §3).
 *
 * The write counterpart to `eas.ts` (encode) and `read.ts` (read). The web
 * `/mint` flow does this in-browser via the connected wallet; this is the
 * programmatic path for a funded EOA (e.g. `MINTER_PRIVATE_KEY`), used by the
 * end-to-end mint script and any headless/CI mint. Same eas-sdk write path
 * proven by `register-schema`.
 */

import { JsonRpcProvider, Wallet, type Signer } from "ethers";
import { EAS } from "./eas-sdk.js";
import { encodeLitmusAttestation } from "./eas.js";
import { networkConfig, selectedNetwork, type Network } from "./networks.js";
import type { EvidenceBundle } from "@polygraph/core";

// EAS NO_EXPIRATION — the fingerprint, not a clock, expires the claim (§3).
const NO_EXPIRATION = 0n;

/** A funded signer from `MINTER_PRIVATE_KEY` on the selected network's RPC. */
export function envSigner(net: Network = selectedNetwork()): Wallet {
  const pk = process.env.MINTER_PRIVATE_KEY;
  if (!pk) throw new Error("MINTER_PRIVATE_KEY is required (a funded EOA).");
  const cfg = networkConfig(net);
  const rpc = (net === "base" ? process.env.BASE_MAINNET_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL) || cfg.rpc;
  return new Wallet(pk.startsWith("0x") ? pk : "0x" + pk, new JsonRpcProvider(rpc, cfg.chainId));
}

export interface AttestResult {
  uid: string;
  txHash: string | null;
}

/** The registered litmus-v1 schema UID for the selected network (from env). */
export function litmusSchemaUID(): string {
  const uid = process.env.NEXT_PUBLIC_EAS_SCHEMA_UID;
  if (!uid) throw new Error("NEXT_PUBLIC_EAS_SCHEMA_UID is required — register the schema first.");
  return uid;
}

/**
 * Sign + submit the attestation, returning its UID once mined. `recipient`
 * defaults to the signer (so a wallet can list "my polygraph proofs").
 */
export async function attestLitmus(
  bundle: EvidenceBundle,
  reportCID: string,
  signer: Signer,
  opts: { recipient?: string; schemaUID?: string } = {},
): Promise<AttestResult> {
  const cfg = networkConfig(selectedNetwork());
  const eas = new EAS(cfg.eas);
  eas.connect(signer);

  const recipient = opts.recipient ?? (await signer.getAddress());
  const data = encodeLitmusAttestation(bundle, reportCID);

  const tx = await eas.attest({
    schema: opts.schemaUID ?? litmusSchemaUID(),
    data: { recipient, expirationTime: NO_EXPIRATION, revocable: true, data },
  });
  const uid = await tx.wait();
  const txHash = (tx as { tx?: { hash?: string } }).tx?.hash ?? null;
  return { uid, txHash };
}
