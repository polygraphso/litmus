/**
 * The agent payment-gate (technical-design §6, onchain-proof-spec §7).
 *
 * Before an agent trusts (and pays) an MCP server, it checks the polygraph
 * cheapest-first:
 *   1. no attestation → refuse
 *   2. live-fingerprint check — recompute the live tool surface; if it ≠ the
 *      attested fingerprint → refuse (rug pull): the surface changed since it
 *      was graded
 *   3. grade check — a failing grade → refuse, 0 spent
 * All pass → pay.
 *
 * `gateDecision` is pure and unit-tested; `liveFingerprint` reuses the harness.
 */

import { connectTarget, fingerprintToolDefs, type TargetInput } from "@polygraph/probes";
import type { ToolDef } from "@polygraph/core";

export interface AttestationView {
  toolDefsFingerprint: string;
  overallGrade: string;
  revoked?: boolean;
}

export type GateAction = "pay" | "refuse";

export interface GateDecision {
  action: GateAction;
  reason: string;
}

/**
 * Optional bond signal. The arbiter-free `PolygraphBond` slashes a disproven
 * grade on-chain (no privileged resolver), so a slashed bond is a refuse signal
 * that does not depend on EAS revocation. `bondSlashed` is read from
 * `@polygraph/onchain` `readBond(uid)` (status === Slashed).
 */
export interface BondView {
  bondSlashed?: boolean;
}

/** Grades an agent will transact with. F (injection/leak) and D (egress) are out. */
export const DEFAULT_PASSING = new Set(["A", "B", "C"]);

export function gateDecision(
  attestation: AttestationView | null,
  liveFingerprint: string,
  passing: Set<string> = DEFAULT_PASSING,
  bond: BondView | null = null,
): GateDecision {
  if (!attestation) {
    return { action: "refuse", reason: "no attestation — unevaluated server" };
  }
  if (attestation.revoked) {
    return { action: "refuse", reason: "attestation revoked" };
  }
  if (bond?.bondSlashed) {
    return { action: "refuse", reason: "bond slashed — grade disproven on-chain" };
  }
  if (attestation.toolDefsFingerprint.toLowerCase() !== liveFingerprint.toLowerCase()) {
    return { action: "refuse", reason: "rug pull — live tool surface differs from the graded one" };
  }
  if (!passing.has(attestation.overallGrade)) {
    return { action: "refuse", reason: `failing grade ${attestation.overallGrade}` };
  }
  return { action: "pay", reason: `grade ${attestation.overallGrade}; live fingerprint matches` };
}

/** Recompute the live tool-surface fingerprint of a target (the mandatory call-time check). */
export async function liveFingerprint(target: TargetInput): Promise<string> {
  const conn = await connectTarget(target);
  try {
    const { tools } = await conn.client.listTools();
    const defs: ToolDef[] = (tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
    }));
    return fingerprintToolDefs(defs).fingerprint;
  } finally {
    await conn.teardown();
  }
}
