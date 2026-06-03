/**
 * Bond demo (Base Sepolia): the threat model end to end. Forge a passing grade,
 * stake it, watch the agent-gate get fooled while the bond is healthy — then any
 * watcher disproves it with a zero-trust on-chain fraud proof (no arbiter), the
 * stake is slashed, and the gate flips to refuse.
 *
 *   node --env-file=../../.env --import tsx src/scripts/bond-demo.ts [ref]
 *
 * Needs MINTER_PRIVATE_KEY (funded with ETH + ≥ minStake USDC), a deployed
 * NEXT_PUBLIC_BOND_ADDRESS, schema UID, RPC.
 */

import {
  attestLitmus,
  envSigner,
  readAttestation,
  readBond,
  stakeBond,
  proveGradeInconsistent,
  BondStatus,
  networkConfig,
  selectedNetwork,
} from "@polygraph/onchain";
import type { EvidenceBundle } from "@polygraph/core";
import { gateDecision, liveFingerprint, type AttestationView } from "../gate.js";

const STAKE = 1_000_000n; // 1 USDC (6 decimals) — the deployed minStake

async function pin(bundle: EvidenceBundle): Promise<string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return "report:forged-demo";
  const res = await fetch(`${url}/rest/v1/litmus_bundles`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify({ bundle }),
  });
  if (!res.ok) return "report:forged-demo";
  return `report:${((await res.json()) as Array<{ id: string }>)[0]!.id}`;
}

/** Poll the bond until it reaches `want` — absorbs public-RPC read lag after a tx. */
async function waitBond(uid: string, want: BondStatus): Promise<BondStatus> {
  for (let i = 0; i < 12; i++) {
    const b = await readBond(uid);
    if (b && b.status === want) return b.status;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return (await readBond(uid))?.status ?? BondStatus.None;
}

async function gate(uid: string, liveFp: string, label: string): Promise<void> {
  const att = await readAttestation(uid);
  const bond = await readBond(uid);
  const view: AttestationView | null = att
    ? { toolDefsFingerprint: att.toolDefsFingerprint, overallGrade: att.overallGrade, revoked: att.revoked }
    : null;
  const bondView = bond ? { bondSlashed: bond.status === BondStatus.Slashed } : null;
  const d = gateDecision(view, liveFp, undefined, bondView);
  process.stdout.write(`    gate (${label}) → ${d.action.toUpperCase()}: ${d.reason}\n`);
}

async function main(): Promise<void> {
  const ref = process.argv[2] ?? "npm/@modelcontextprotocol/server-sequential-thinking";
  const net = selectedNetwork();
  const cfg = networkConfig(net);
  const out = (s: string) => process.stdout.write(s + "\n");
  const signer = envSigner(net);
  out(`▶ bond demo on ${net} — forge → stake → slash\n`);

  // Use the server's real live fingerprint so the gate's rug-pull check passes;
  // the forgery is in the GRADE, not the surface.
  const liveFp = await liveFingerprint(ref);

  // 1 — forge: a hand-built bundle that publishes "A" while C-01 actually fails.
  out("1 forge — minting a DISHONEST attestation (grade A, but C-01 verdict = fail)…");
  const forged: EvidenceBundle = {
    schemaVersion: "1.0.0",
    methodologyVersion: "litmus-v1",
    serverRef: ref,
    resolvedVersion: null,
    target: { kind: "stdio", command: ref, url: null },
    toolDefsFingerprint: liveFp,
    toolDefs: [],
    ranAt: new Date().toISOString(),
    harness: { package: "@polygraph/probes", version: "0.0.0", node: process.version, dockerAvailable: false },
    categories: [
      { code: "C-01", status: "fail", probes: [] },
      { code: "C-02", status: "pass", probes: [] },
      { code: "C-03", status: "pass", probes: [] },
    ],
    grade: "A",
    gradeRationale: "(forged — inconsistent with verdicts)",
    disclaimer: "(forged demo attestation)",
  };
  const cid = await pin(forged);
  const { uid } = await attestLitmus(forged, cid, signer);
  out(`    forged attestation ${uid}`);
  out(`    ${cfg.easscan}/attestation/view/${uid}\n`);

  // 2 — stake behind the grade; the gate trusts it while the bond is healthy.
  out("2 stake — minter stakes 1 USDC behind the forged grade…");
  const { stakeTx } = await stakeBond(uid, STAKE, signer);
  out(`    bond ${BondStatus[await waitBond(uid, BondStatus.Staked)]}  (tx ${stakeTx.slice(0, 12)}…)`);
  await gate(uid, liveFp, "bond healthy — forgery undetected");
  out("");

  // 3 — any watcher disproves it on-chain (grade ≠ committed verdicts). No arbiter.
  out("3 slash — a watcher calls proveGradeInconsistent (zero-trust fraud proof)…");
  const slashTx = await proveGradeInconsistent(uid, signer);
  out(`    bond ${BondStatus[await waitBond(uid, BondStatus.Slashed)]}  (tx ${slashTx.slice(0, 12)}…) — stake paid to the prover`);
  await gate(uid, liveFp, "after slash");
}

main().catch((err: unknown) => {
  process.stderr.write(`bond-demo failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
