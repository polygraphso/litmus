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
 * All pass → pay. A value/payment path can opt into stricter rules via
 * `GateOptions` (attester allowlist, accepted methodology versions, and
 * `requireEgressVerified` — which rejects remote/no-sandbox B grades).
 *
 * `gateDecision` is pure and unit-tested; `liveFingerprint` reuses the harness
 * and returns the connected server's canonical ref so the binding compares
 * apples to apples.
 */

import { connectTarget, enumerateTools, fingerprintToolDefs, type TargetInput, type ListToolsClient } from "@polygraph/probes";
import type { ToolDef } from "@polygraph/core";

export interface AttestationView {
  /** Canonical ref the attestation was minted for (binds grade↔server). */
  serverRef: string;
  toolDefsFingerprint: string;
  overallGrade: string;
  /**
   * The version the grade was run against, surfaced for the human/agent log.
   * ADVISORY ONLY: there is no trustworthy live-version oracle, so this never
   * affects the decision — the fingerprint is the sole cryptographic anchor.
   */
  resolvedVersion?: string | null;
  revoked?: boolean;
  /** EAS expiry in unix seconds; 0n / undefined = no expiration. */
  expirationTime?: bigint;
  /** Account that signed the attestation. A self-minted grade is forgeable, so a
   *  caller routing value can pin an `allowedAttesters` set (or re-run the harness). */
  attester?: string;
  /** Methodology version the grade was produced under (signed attestation data).
   *  Unlike `resolvedVersion`, this is not a live-oracle claim, so a caller may
   *  require it via `acceptedMethodologyVersions`. */
  methodologyVersion?: string;
  /** True only when C-02 (egress) actually ran AND passed. False/undefined for
   *  remote or no-sandbox B grades, where egress was never observed. */
  egressVerified?: boolean;
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

/** Grades an agent will transact with by default. F (injection/leak) and D
 *  (egress) are out — and so is C: under litmus-v16 C is a live grade meaning a
 *  destructive/value-moving tool was left unexercised AND a category was not
 *  verified (a powerful server we could neither sandbox nor exercise), so it is
 *  refused by default. Only A and the single-caveat B transact without opt-in. */
export const DEFAULT_PASSING = new Set(["A", "B"]);

/** The bar for signed/value actions. Only a LOCAL A clears it: remote servers
 *  cap at B (egress unverified), so requiring A excludes egress-unverified grades. */
export const PAYMENT_PASSING = new Set(["A"]);

/**
 * Optional, stricter trust rules — all default off, so the base decision is
 * unchanged unless a caller opts in. Use these on a value/payment path.
 */
export interface GateOptions {
  /** If set, the attestation's signer must be one of these (lowercased addresses).
   *  Self-minted grades are forgeable; an allowlist trades reproducibility for a
   *  known-signer assumption. */
  allowedAttesters?: Set<string>;
  /** If set, the grade's methodology version must be one of these. */
  acceptedMethodologyVersions?: Set<string>;
  /** Refuse unless C-02 (egress) actually ran clean. Rejects remote/no-sandbox B
   *  grades whose network behavior was never observed. */
  requireEgressVerified?: boolean;
}

export function gateDecision(
  attestation: AttestationView | null,
  live: LiveTarget,
  passing: Set<string> = DEFAULT_PASSING,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
  opts: GateOptions = {},
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
  // Provenance (opt-in): a self-minted grade is forgeable, so a value path can
  // require a known signer. Fail closed when no attester is present.
  if (opts.allowedAttesters && !(attestation.attester && opts.allowedAttesters.has(attestation.attester.toLowerCase()))) {
    return { action: "refuse", reason: "attester not in allowlist — self-minted grades are forgeable; trust a known attester or re-run the harness" };
  }
  // Methodology pinning (opt-in): refuse a grade from an unaccepted methodology.
  if (opts.acceptedMethodologyVersions && !(attestation.methodologyVersion && opts.acceptedMethodologyVersions.has(attestation.methodologyVersion))) {
    return { action: "refuse", reason: `methodology version ${attestation.methodologyVersion ?? "unknown"} not accepted` };
  }
  if (!passing.has(attestation.overallGrade)) {
    return { action: "refuse", reason: `failing grade ${attestation.overallGrade}` };
  }
  // Egress (opt-in, for signed/value actions): a remote or no-sandbox B never
  // had its network behavior observed. Fail closed when the flag is missing.
  if (opts.requireEgressVerified && attestation.egressVerified !== true) {
    return { action: "refuse", reason: "egress unverified (remote or no-sandbox grade) — not eligible for signed actions" };
  }
  // The version is appended to the reason only — it is NOT a gate condition (no
  // refuse branch on version): there is no trustworthy live-version oracle, so
  // the fingerprint above remains the sole cryptographic anchor.
  const versionNote = attestation.resolvedVersion ? ` (graded version ${attestation.resolvedVersion})` : "";
  return { action: "pay", reason: `grade ${attestation.overallGrade}; live fingerprint matches${versionNote}` };
}

/**
 * Canonical fingerprint of a connected server's FULL tool surface, following
 * `tools/list` pagination to exhaustion via the same `enumerateTools` the
 * grading harness uses — identical caps and canonicalization. This is the
 * load-bearing half of the rug-pull check: a single `listTools()` call would
 * read only page 1, so a server could park a malicious tool behind `nextCursor`
 * after grading and the live recheck would still match the attested page-1 hash.
 * Enumerating every page makes the live hash cover what the agent actually gets.
 * Exported so the paginated path is unit-testable without a live connection.
 */
export async function fingerprintLiveSurface(client: ListToolsClient): Promise<string> {
  const defs: ToolDef[] = (await enumerateTools(client)).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? null,
  }));
  return fingerprintToolDefs(defs).fingerprint;
}

/**
 * Recompute the live tool-surface fingerprint of a target (the mandatory
 * call-time check) and return the connected server's canonical ref alongside it,
 * so the gate can bind the attestation to the actual server.
 */
export async function liveFingerprint(target: TargetInput): Promise<LiveTarget> {
  const conn = await connectTarget(target);
  try {
    return { fingerprint: await fingerprintLiveSurface(conn.client), serverRef: conn.serverRef };
  } finally {
    await conn.teardown();
  }
}
