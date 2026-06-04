/**
 * `verify_attestation` — read an MCP server's onchain polygraph before an agent
 * trusts or pays it. Brand-voiced (plain, no hype, no overclaim) like core's
 * tools. The caller must still re-check the LIVE fingerprint before paying.
 */

import { z } from "zod";
import { readAttestation, selectedNetwork } from "@polygraph/onchain";
import { parseServerRef, serverKey } from "@polygraph/core";

/** Canonical (versionless, lower-cased) form for comparing a requested ref to
 *  the ref baked into the on-chain attestation. Falls back to the raw string for
 *  URL / local-path targets that aren't registry refs. */
function canonicalRef(ref: string): string {
  try {
    return serverKey(parseServerRef(ref)).toLowerCase();
  } catch {
    return ref.trim().toLowerCase();
  }
}

export const VERIFY_TOOL_NAME = "verify_attestation";
export const VERIFY_TOOL_TITLE = "Verify a server's polygraph attestation";
export const VERIFY_TOOL_DESCRIPTION = [
  "Read the onchain polygraph (litmus) attestation for an MCP server before an",
  "agent trusts — or, in agentic commerce, pays — it.",
  "",
  "Returns the behavioral grade (A–F), the attestation UID, the evidence CID,",
  "and the graded tool-surface fingerprint. The caller must still recompute the",
  "LIVE fingerprint and require it to equal the attested one before paying — a",
  "passing attestation can otherwise front for a tool surface the server no",
  "longer serves (rug pull).",
  "",
  "Input: server_ref — e.g. npm/@modelcontextprotocol/server-filesystem. Returns",
  "not_available when there is no attestation: treat that as unevaluated —",
  "neither safe nor unsafe.",
].join("\n");

export const verifyInputShape = {
  server_ref: z
    .string()
    .min(1)
    .max(512)
    .describe("Registry-prefixed server identifier, e.g. npm/@scope/server."),
};

export async function handleVerify({ server_ref }: { server_ref: string }) {
  const uid = await resolveUid(server_ref);
  const att = uid ? await readAttestation(uid) : null;
  if (!att) {
    return {
      content: [{ type: "text" as const, text: `not_available — no polygraph attestation for ${server_ref}` }],
    };
  }
  // The UID came from the (untrusted) discovery index; bind it to the on-chain
  // serverRef so a poisoned mapping can't front a grade earned by a DIFFERENT
  // server. The trust-critical serverRef lives in the signed attestation.
  if (canonicalRef(att.serverRef) !== canonicalRef(server_ref)) {
    return {
      content: [
        {
          type: "text" as const,
          text: `not_available — the resolved attestation is for ${att.serverRef}, not ${server_ref} (discovery mismatch; treat as unevaluated)`,
        },
      ],
    };
  }
  const payload = {
    status: "attested",
    grade: att.overallGrade,
    attestationUid: att.uid,
    serverRef: att.serverRef,
    reportCID: att.reportCID,
    toolDefsFingerprint: att.toolDefsFingerprint,
    revoked: att.revoked,
    network: selectedNetwork(),
    liveFingerprintCheckRequired:
      "Recompute the live tool-surface fingerprint and require it to equal toolDefsFingerprint before paying.",
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

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
