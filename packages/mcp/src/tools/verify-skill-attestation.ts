/**
 * `verify_skill_attestation` — read a skill's already-published polygraph grade
 * (no run) before an agent installs or trusts it. The skill analogue of
 * `verify_attestation`: instead of recomputing a LIVE tool-surface fingerprint,
 * the consumer must recompute the skill's CONTENT HASH (sha256 of every file the
 * SKILL.md can load) and require it to equal the attested `contentHash` before
 * installing — there is no live re-fingerprint, so the hash is the only thing
 * binding the grade to the bytes that run.
 */

import { z } from "zod";
import { readSkillAttestation, selectedNetwork } from "@polygraph/onchain";
import { parseSkillRef, skillKey } from "@polygraph/core";

/** Canonical (versionless, lower-cased) skill identity for comparing a requested
 *  ref to the one baked into the on-chain attestation. Falls back to the raw
 *  string for local paths / non-canonical refs. */
function canonicalRef(ref: string): string {
  try {
    return skillKey(parseSkillRef(ref)).toLowerCase();
  } catch {
    return ref.trim().toLowerCase();
  }
}

export const VERIFY_SKILL_TOOL_NAME = "verify_skill_attestation";
export const VERIFY_SKILL_TOOL_TITLE = "Verify a skill's polygraph attestation";
export const VERIFY_SKILL_TOOL_DESCRIPTION = [
  "Read a Claude Code / Agent Skill's already-published polygraph grade — without",
  "running anything — before an agent installs or trusts it.",
  "",
  "When a grade is published it returns the letter (A/B/D/F), the attestation UID,",
  "the evidence CID, and the attested contentHash. The caller MUST then recompute the",
  "skill's content hash (sha256 over every file the SKILL.md can load, including",
  "lazily-referenced files) and require it to equal contentHash before installing — a",
  "passing attestation can otherwise front for different bytes (a swapped bundled",
  "script). The ref/version is advisory; the contentHash is the trust anchor.",
  "",
  "Grade publishing for skills is rolling out, so this commonly returns not_available:",
  "that means UNEVALUATED (neither safe nor unsafe), not a failing grade — to grade a",
  "local skill yourself, use `run_skill_litmus`. A `lookup_failed` result means the",
  "lookup itself failed (index/chain unreachable); the grade is unknown, not unevaluated.",
  "",
  "Input: skill_ref — e.g. github/<owner>/<repo>#<path> or marketplace/<owner>/<name>.",
].join("\n");

export const verifySkillInputShape = {
  skill_ref: z
    .string()
    .min(1)
    .max(1024)
    .describe("Skill identifier, e.g. github/<owner>/<repo>#<path> or marketplace/<owner>/<name>."),
};

export async function handleVerifySkill({ skill_ref }: { skill_ref: string }) {
  const found = await resolveUid(skill_ref);
  if (found.kind === "error") {
    return errorResult(
      `lookup_failed — could not reach the polygraph skill-grade index for ${skill_ref} (${found.detail}). The lookup itself failed, so the grade is unknown — retry or report it as unchecked, NOT as unevaluated.`,
    );
  }

  let att: Awaited<ReturnType<typeof readSkillAttestation>> | null = null;
  if (found.kind === "found") {
    try {
      att = await readSkillAttestation(found.uid);
    } catch (err) {
      return errorResult(
        `lookup_failed — the onchain read failed for ${skill_ref} (${err instanceof Error ? err.message : String(err)}). Treat as unchecked (the chain/RPC was unreachable), not as "no grade".`,
      );
    }
  }

  if (!att) {
    return text(
      `not_available — no published polygraph grade for ${skill_ref}. Skill grade publishing is still rolling out, so this is expected; it means unevaluated (neither safe nor unsafe), not a failing grade. To grade a local skill now, use run_skill_litmus.`,
    );
  }
  // Bind the (untrusted) discovery UID to the on-chain skillRef so a poisoned
  // mapping can't front a grade earned by a DIFFERENT skill.
  if (canonicalRef(att.skillRef) !== canonicalRef(skill_ref)) {
    return text(
      `not_available — the resolved attestation is for ${att.skillRef}, not ${skill_ref} (discovery mismatch; treat as unevaluated).`,
    );
  }
  const payload = {
    status: "attested",
    grade: att.overallGrade,
    attestationUid: att.uid,
    skillRef: att.skillRef,
    contentHash: att.contentHash,
    resolvedRef: att.resolvedRef,
    reportCID: att.reportCID,
    revoked: att.revoked,
    network: selectedNetwork(),
    contentHashCheckRequired:
      "Recompute sha256 over every file the SKILL.md can load (including lazily-referenced files) and require it to equal contentHash before installing. The ref/version is advisory.",
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}
function errorResult(t: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: t }] };
}

type Lookup = { kind: "found"; uid: string } | { kind: "none" } | { kind: "error"; detail: string };

async function resolveUid(skillRef: string): Promise<Lookup> {
  const base = process.env.POLYGRAPH_API_URL ?? "https://polygraph.so";
  try {
    const res = await fetch(`${base}/api/skill-attestations?ref=${encodeURIComponent(skillRef)}`);
    if (res.status === 404) return { kind: "none" };
    if (!res.ok) return { kind: "error", detail: `grade index returned HTTP ${res.status}` };
    const row = (await res.json()) as { attestation_uid?: string } | null;
    return row?.attestation_uid ? { kind: "found", uid: row.attestation_uid } : { kind: "none" };
  } catch (err) {
    return { kind: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}
