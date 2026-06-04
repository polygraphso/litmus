/**
 * Headline agent-gate demo (technical-design §6). For a server: resolve its
 * attestation UID, read it on-chain, recompute the LIVE fingerprint, then gate:
 * pay the clean server over x402 / refuse the malicious one (0 spent).
 *
 *   pnpm --filter @polygraph/agent demo <server_ref> [target]
 *
 * Needs a registered schema + a minted attestation + an RPC (and, to actually
 * pay, x402 + DEMO_AGENT_PRIVATE_KEY). See plans/external-needs.md.
 */

import { readAttestation, readBond, BondStatus } from "@polygraph/onchain";
import { gateDecision, liveFingerprint, type AttestationView } from "../gate.js";

async function resolveUid(serverRef: string): Promise<string | null> {
  const base = process.env.POLYGRAPH_API_URL ?? "https://polygraph.so";
  try {
    const res = await fetch(`${base}/api/attestations?ref=${encodeURIComponent(serverRef)}`);
    if (!res.ok) return null;
    const row = (await res.json()) as { attestation_uid?: string } | null;
    return row?.attestation_uid ?? null;
  } catch {
    return null;
  }
}

async function gate(serverRef: string, target: string): Promise<void> {
  const uid = await resolveUid(serverRef);
  const att = uid ? await readAttestation(uid) : null;
  const view: AttestationView | null = att
    ? {
        serverRef: att.serverRef,
        toolDefsFingerprint: att.toolDefsFingerprint,
        overallGrade: att.overallGrade,
        revoked: att.revoked,
        expirationTime: att.expirationTime,
      }
    : null;

  // The arbiter-free bond slashes a disproven grade on-chain; a slashed bond is
  // a refuse signal independent of EAS revocation (onchain-proof-spec §9).
  const bond = uid ? await readBond(uid) : null;
  const bondView = bond ? { bondSlashed: bond.status === BondStatus.Slashed } : null;

  const live = await liveFingerprint(target);
  const decision = gateDecision(view, live, undefined, bondView);

  process.stdout.write(`${serverRef}\n  → ${decision.action}: ${decision.reason}\n`);
  if (decision.action === "pay") {
    // [verify] x402: wrapFetchWithPayment(fetch, account) over the paid tool,
    // account = privateKeyToAccount(DEMO_AGENT_PRIVATE_KEY). Pays the 402 in USDC.
    process.stdout.write("  → pay the 402 in USDC over x402, then call the tool\n");
  } else {
    process.stdout.write("  → 0 USDC spent\n");
  }
}

async function main(): Promise<void> {
  const ref = process.argv[2];
  if (!ref) {
    process.stderr.write("usage: demo-agent <server_ref> [target-ref-or-url]\n");
    process.exit(2);
  }
  const target = process.argv[3] ?? ref;
  await gate(ref, target);
}

main().catch((err: unknown) => {
  process.stderr.write(`demo-agent: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
