/**
 * `verify_attestation` — read an MCP server's onchain polygraph before an agent
 * trusts or pays it. Brand-voiced (plain, no hype, no overclaim) like core's
 * tools. The caller must still re-check the LIVE fingerprint before paying.
 */

import { z } from "zod";
import { readAttestation, selectedNetwork } from "@polygraph/onchain";

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
  const payload = {
    status: "attested",
    grade: att.overallGrade,
    attestationUid: att.uid,
    reportCID: att.reportCID,
    toolDefsFingerprint: att.toolDefsFingerprint,
    revoked: att.revoked,
    network: selectedNetwork(),
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
