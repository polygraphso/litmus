/**
 * End-to-end mint flow (programmatic): litmus → pin → EAS attest → read back →
 * agent-gate. The headless counterpart to the web `/mint` (connected-wallet)
 * flow, for testing the full pipeline against a real MCP on Base Sepolia.
 *
 *   node --env-file=../../.env --import tsx src/scripts/mint-and-gate.ts [ref]
 *
 * Needs MINTER_PRIVATE_KEY (funded), NEXT_PUBLIC_EAS_SCHEMA_UID, PINATA_JWT, RPC.
 */

import { runLitmus } from "@polygraph/probes";
import { attestLitmus, envSigner, readAttestation, networkConfig, selectedNetwork, pinEvidence } from "@polygraph/onchain";
import { gateDecision, liveFingerprint, type AttestationView } from "../gate.js";

async function main(): Promise<void> {
  const ref = process.argv[2] ?? "npm/@modelcontextprotocol/server-everything";
  const net = selectedNetwork();
  const cfg = networkConfig(net);
  const out = (s: string) => process.stdout.write(s + "\n");

  out(`▶ full mint flow on ${net} — ${ref}\n`);

  // 1 — litmus
  out("1/5 litmus — running the behavioral harness…");
  const bundle = await runLitmus(ref);
  out(`    grade ${bundle.grade}  ·  fingerprint ${bundle.toolDefsFingerprint.slice(0, 18)}…`);
  out(`    ${bundle.categories.map((c) => `${c.code}:${c.status}`).join("  ")}\n`);

  // 2 — pin (Pinata → Supabase fallback)
  out("2/5 pin — publishing the evidence bundle…");
  const pin = await pinEvidence(bundle);
  out(`    reportCID ${pin.cid}  (via ${pin.via})`);
  if (pin.gateway) out(`    ${pin.gateway}`);
  out("");

  // 3 — mint
  out("3/5 mint — signing the EAS attestation…");
  const signer = envSigner(net);
  const { uid, txHash } = await attestLitmus(bundle, pin.cid, signer);
  out(`    attestation ${uid}`);
  if (txHash) out(`    tx ${txHash}`);
  out(`    ${cfg.easscan}/attestation/view/${uid}\n`);

  // 4 — read back on-chain (the trust-critical read; not from a DB)
  out("4/5 read — fetching the attestation back from chain…");
  const att = await readAttestation(uid);
  if (!att) throw new Error("attestation not found on-chain after mint");
  out(`    on-chain grade ${att.overallGrade}  ·  reportCID ${att.reportCID}  ·  revoked ${att.revoked}\n`);

  // 5 — agent-gate: live-fingerprint re-check + grade
  out("5/5 gate — re-checking the live fingerprint and deciding…");
  const live = await liveFingerprint(ref);
  const view: AttestationView = {
    serverRef: att.serverRef,
    toolDefsFingerprint: att.toolDefsFingerprint,
    overallGrade: att.overallGrade,
    revoked: att.revoked,
    expirationTime: att.expirationTime,
  };
  const decision = gateDecision(view, live);
  out(`    live fingerprint ${live.fingerprint.slice(0, 18)}…  (${live.fingerprint.toLowerCase() === att.toolDefsFingerprint.toLowerCase() ? "matches attested" : "MISMATCH — rug pull"})`);
  out(`    → ${decision.action.toUpperCase()}: ${decision.reason}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`mint-and-gate failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
