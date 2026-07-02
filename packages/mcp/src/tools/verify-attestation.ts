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
  "Read a server's already-published polygraph (litmus) grade — without running",
  "anything — before an agent trusts or, in agentic commerce, pays it.",
  "",
  "When a grade is published it returns the behavioral grade (A–F), the attestation",
  "UID, the evidence CID, and the graded tool-surface fingerprint. The caller must",
  "still recompute the LIVE fingerprint and require it to equal the attested one",
  "before paying — a passing attestation can otherwise front for a tool surface the",
  "server no longer serves (rug pull).",
  "",
  "Grade publishing is still rolling out, so this commonly returns not_available",
  "today: that means UNEVALUATED (neither safe nor unsafe), not a failing grade — to",
  "grade the server yourself right now, use `run_litmus`. A `lookup_failed` result",
  "means the lookup itself failed (the index or chain was unreachable); the grade is",
  "unknown, which is not the same as unevaluated.",
  "",
  "Input: server_ref — e.g. npm/@modelcontextprotocol/server-filesystem.",
].join("\n");

export const verifyInputShape = {
  server_ref: z
    .string()
    .min(1)
    .max(512)
    .describe("Registry-prefixed server identifier, e.g. npm/@scope/server."),
};

export async function handleVerify({ server_ref }: { server_ref: string }) {
  // A failed lookup is NOT the same as "no grade": a network/index/RPC outage
  // must surface as lookup_failed (unknown), never collapse into not_available
  // (unevaluated), or an agent would treat an unreachable index as a verdict.
  const found = await resolveUid(server_ref);
  if (found.kind === "error") {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: `lookup_failed — could not reach the polygraph grade index for ${server_ref} (${found.detail}). The lookup itself failed, so the grade is unknown — retry or report it as unchecked, NOT as unevaluated.`,
        },
      ],
    };
  }

  let att: Awaited<ReturnType<typeof readAttestation>> | null = null;
  if (found.kind === "found") {
    try {
      att = await readAttestation(found.uid);
    } catch (err) {
      return {
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text: `lookup_failed — the onchain read failed for ${server_ref} (${err instanceof Error ? err.message : String(err)}). Treat as unchecked (chain/RPC or schema config issue), not as "no grade".`,
          },
        ],
      };
    }
    // The index returned a UID but the chain couldn't corroborate it — wrong network,
    // schema mismatch, or revocation edge. This is NOT the same as "unevaluated": the
    // trusted index asserts a grade the chain can't confirm, which is a lookup failure.
    if (!att) {
      return {
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text: `lookup_failed — the grade index returned a UID for ${server_ref} but the chain could not corroborate it (wrong network, schema mismatch, or the attestation was removed). Treat as unchecked, not as unevaluated.`,
          },
        ],
      };
    }
  }

  if (!att) {
    return {
      content: [
        {
          type: "text" as const,
          text: `not_available — no published polygraph grade for ${server_ref}. Grade publishing is still rolling out, so this is expected for most servers; it means unevaluated (neither safe nor unsafe), not a failing grade. To grade it now, use run_litmus.`,
        },
      ],
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
  // Surface revocation and expiry unambiguously so an LLM reading the JSON payload
  // draws the right conclusion. gateDecision already refuses both; this is the
  // display tool — it must not present a revoked grade as "attested".
  const expired = att.expirationTime > 0n && att.expirationTime < BigInt(Math.floor(Date.now() / 1000));
  const status = att.revoked ? "revoked" : expired ? "expired" : "attested";
  const payload = {
    status,
    grade: att.overallGrade,
    attestationUid: att.uid,
    serverRef: att.serverRef,
    // The version the grade was run against (null for HTTP/unresolved targets).
    // Advisory: the live fingerprint, not this string, is the trust anchor.
    resolvedVersion: att.resolvedVersion,
    evidenceHash: att.evidenceHash,
    evidenceURI: att.evidenceURI,
    categories: att.categories,
    toolDefsFingerprint: att.toolDefsFingerprint,
    ...(att.expirationTime > 0n ? { expirationTime: att.expirationTime.toString() } : {}),
    network: selectedNetwork(),
    liveFingerprintCheckRequired:
      "Recompute the live tool-surface fingerprint and require it to equal toolDefsFingerprint before paying.",
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Discovery-lookup outcome: a UID was found, none is published, or the lookup
 *  itself failed (network/HTTP/body) — kept distinct so a failure is never read
 *  as "unevaluated". */
type Lookup = { kind: "found"; uid: string } | { kind: "none" } | { kind: "error"; detail: string };

async function resolveUid(serverRef: string): Promise<Lookup> {
  const base = process.env.POLYGRAPH_API_URL ?? "https://polygraph.so";
  try {
    const res = await fetch(`${base}/api/attestations?ref=${encodeURIComponent(serverRef)}`);
    // 404 = no row (or the discovery endpoint isn't live yet) → "none", which
    // surfaces as the honest not_available. Any other non-2xx is a real lookup
    // failure the agent must not read as a verdict.
    if (res.status === 404) return { kind: "none" };
    if (!res.ok) return { kind: "error", detail: `grade index returned HTTP ${res.status}` };
    const row = (await res.json()) as { attestation_uid?: string } | null;
    return row?.attestation_uid ? { kind: "found", uid: row.attestation_uid } : { kind: "none" };
  } catch (err) {
    return { kind: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}
