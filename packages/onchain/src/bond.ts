/**
 * PolygraphBond (arbiter-free) interop — the off-chain side of the trust layer.
 *
 * Two jobs:
 *   1. Let the agent-gate read a bond's status on-chain, so a *slashed* grade is
 *      refused even before EAS revocation (revocation is cosmetic in this design).
 *   2. Let a re-runner / the CLI turn a re-run's EvidenceBundle into the exact
 *      commit-reveal values the contract tallies — the *static core* that runs
 *      anywhere with no sandbox: (toolDefsFingerprint, C-01 verdict, output-canary
 *      leak). Honest runs of the deterministic harness produce identical cores,
 *      which is what makes the quorum a Schelling point.
 *
 * The digest/commitment encodings mirror PolygraphBond.sol exactly; the
 * Hardhat suite asserts the on-chain side, the onchain vitest asserts this side.
 */

import { AbiCoder, JsonRpcProvider, Interface, keccak256 } from "ethers";
import { CATEGORY_STATUS_UINT8, type EvidenceBundle } from "@polygraph/core";
import { networkConfig } from "./networks.js";

const abi = AbiCoder.defaultAbiCoder();

/** Mirrors PolygraphBond.Status. */
export enum BondStatus {
  None = 0,
  Staked = 1,
  Disputed = 2,
  Slashed = 3,
  Withdrawn = 4,
  Cleared = 5,
}

/** The static-core a re-runner reveals (the anywhere-deterministic result). */
export interface StaticCore {
  /** `0x` + 64 hex (bytes32) — the recomputed tool-surface fingerprint. */
  fingerprint: string;
  /** C-01 category verdict as the attestation uint8 (0=pass, 1=fail, 2=skipped). */
  c01: number;
  /** Probe 4.1 (output-canary leak) hit — the anywhere-detectable C-03 vector. */
  outputLeak: boolean;
}

/** Extract the static core from a re-run's evidence bundle. */
export function staticCoreFields(bundle: EvidenceBundle): StaticCore {
  const c01 = bundle.categories.find((c) => c.code === "C-01");
  const c03 = bundle.categories.find((c) => c.code === "C-03");
  const probe41 = c03?.probes.find((p) => p.id === "4.1");
  return {
    fingerprint: bundle.toolDefsFingerprint,
    c01: CATEGORY_STATUS_UINT8[c01?.status ?? "skipped"],
    outputLeak: probe41?.status === "fail",
  };
}

/** keccak256(abi.encode(bytes32,uint8,bool)) — the consensus key the contract tallies. */
export function staticCoreDigest(core: StaticCore): string {
  return keccak256(abi.encode(["bytes32", "uint8", "bool"], [core.fingerprint, core.c01, core.outputLeak]));
}

/** keccak256(abi.encode(bytes32,uint8,bool,bytes32)) — the commit-phase hash. */
export function reRunCommitment(core: StaticCore, salt: string): string {
  return keccak256(abi.encode(["bytes32", "uint8", "bool", "bytes32"], [core.fingerprint, core.c01, core.outputLeak, salt]));
}

const BOND_ABI = new Interface([
  "function bondOf(bytes32 uid) view returns (tuple(address minter, uint256 amount, uint64 challengeDeadline, uint8 status, address challenger, uint256 counterStake, uint64 commitDeadline, uint64 revealDeadline, uint32 committerCount, bytes32 leadDigest, uint64 leadVotes, uint64 totalReveals, bytes32 conFingerprint, uint8 conC01, bool conOutputLeak, bool resolved, bool inconclusive, bytes32 winningDigest, uint256 rewardPerWinner))",
]);

export interface BondView {
  status: BondStatus;
  minter: string;
  amount: bigint;
  resolved: boolean;
}

/** The bond contract address for the selected network (set after deploy). */
export function bondAddress(): string | null {
  return process.env.NEXT_PUBLIC_BOND_ADDRESS || null;
}

/**
 * Read a bond's on-chain state. Returns null if no bond address is configured or
 * the uid was never staked (status None) — callers treat "no bond" as "no extra
 * signal", not as a pass.
 */
export async function readBond(uid: string, address: string | null = bondAddress()): Promise<BondView | null> {
  if (!address) return null;
  const cfg = networkConfig();
  const provider = new JsonRpcProvider(cfg.rpc, cfg.chainId);
  const data = BOND_ABI.encodeFunctionData("bondOf", [uid]);
  const raw = await provider.call({ to: address, data });
  const [b] = BOND_ABI.decodeFunctionResult("bondOf", raw);
  const status = Number(b.status) as BondStatus;
  if (status === BondStatus.None) return null;
  return { status, minter: b.minter, amount: b.amount, resolved: b.resolved };
}
