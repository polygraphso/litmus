/**
 * The agent payment-gate (technical-design §6, onchain-proof-spec §7).
 *
 * Before an agent trusts (and pays) an MCP server, it checks the polygraph
 * cheapest-first:
 *   1. no attestation → refuse
 *   2. server-ref binding — the attestation must be FOR this server, not a
 *      grade-A attestation minted over a *different* server → refuse on mismatch
 *   3. live-fingerprint check — recompute the live tool surface; if it ≠ the
 *      attested fingerprint → refuse (rug pull): the surface changed since it
 *      was graded
 *   4. grade check — a failing grade → refuse, 0 spent
 * All pass → pay.
 *
 * `gateDecision` is pure and unit-tested; `liveFingerprint` reuses the harness
 * and returns the connected server's canonical ref so the binding compares
 * apples to apples.
 */

import { connectTarget, fingerprintToolDefs, type TargetInput } from "@polygraph/probes";
import type { ToolDef } from "@polygraph/core";

export interface AttestationView {
  /** Canonical ref the attestation was minted for (binds grade↔server). */
  serverRef: string;
  toolDefsFingerprint: string;
  overallGrade: string;
  revoked?: boolean;
  /** EAS expiry in unix seconds; 0n / undefined = no expiration. */
  expirationTime?: bigint;
}

export interface LiveTarget {
  fingerprint: string;
  serverRef: string;
}

/** Case/space-insensitive ref comparison (both sides come from `serverKey`/URL). */
function sameServer(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export type GateAction = "pay" | "refuse";

export interface GateDecision {
  action: GateAction;
  reason: string;
}

/** Grades an agent will transact with. F (injection/leak) and D (egress) are out. */
export const DEFAULT_PASSING = new Set(["A", "B", "C"]);

export function gateDecision(
  attestation: AttestationView | null,
  live: LiveTarget,
  passing: Set<string> = DEFAULT_PASSING,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): GateDecision {
  if (!attestation) {
    return { action: "refuse", reason: "no attestation — unevaluated server" };
  }
  if (attestation.revoked) {
    return { action: "refuse", reason: "attestation revoked" };
  }
  const exp = attestation.expirationTime ?? 0n;
  if (exp !== 0n && now >= exp) {
    return { action: "refuse", reason: "attestation expired" };
  }
  // Server-ref binding: a grade is only meaningful for the server it was minted
  // over. The attested fingerprint is attacker-chosen data, so "fingerprint
  // matches" alone lets a grade-A attestation minted over a DIFFERENT server be
  // replayed for this one. Require the attestation to name this exact server.
  if (!sameServer(attestation.serverRef, live.serverRef)) {
    return { action: "refuse", reason: "attestation is for a different server than the one being gated" };
  }
  if (attestation.toolDefsFingerprint.toLowerCase() !== live.fingerprint.toLowerCase()) {
    return { action: "refuse", reason: "rug pull — live tool surface differs from the graded one" };
  }
  if (!passing.has(attestation.overallGrade)) {
    return { action: "refuse", reason: `failing grade ${attestation.overallGrade}` };
  }
  return { action: "pay", reason: `grade ${attestation.overallGrade}; live fingerprint matches` };
}

/**
 * Recompute the live tool-surface fingerprint of a target (the mandatory
 * call-time check) and return the connected server's canonical ref alongside it,
 * so the gate can bind the attestation to the actual server.
 */
export async function liveFingerprint(target: TargetInput): Promise<LiveTarget> {
  const conn = await connectTarget(target);
  try {
    const { tools } = await conn.client.listTools();
    const defs: ToolDef[] = (tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
    }));
    return { fingerprint: fingerprintToolDefs(defs).fingerprint, serverRef: conn.serverRef };
  } finally {
    await conn.teardown();
  }
}
