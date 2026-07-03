/**
 * `run_skill_litmus` — run the deterministic static safety litmus over a Claude
 * Code / Agent Skill (a SKILL.md + bundle) and return the grade + evidence.
 *
 * Unlike `run_litmus` (which LAUNCHES an MCP server's code), this is a pure STATIC
 * read of the skill's text and bundled files — no execution. Grades a local skill
 * directory or a public GitHub skill (URL / github/<owner>/<repo>#<path>), which is
 * downloaded and scanned locally. The disclosed limit stands: a static A is not
 * behavioral proof.
 */

import { z } from "zod";
import { resolveSkillDir } from "../skill-remote.js";
import {
  runSkillLitmus,
  runSkillQuality,
  runSkillQualityJudged,
  SKILL_CATEGORY_META,
  SKILL_METHODOLOGY_VERSION,
  type SkillEvidenceBundle,
  type QualityBundle,
  type Judge,
} from "@polygraph/probes";

export const RUN_SKILL_LITMUS_TOOL_NAME = "run_skill_litmus";
export const RUN_SKILL_LITMUS_TOOL_TITLE = "Run a safety litmus on a Claude Code skill";
export const RUN_SKILL_LITMUS_TOOL_DESCRIPTION = [
  `Grade a Claude Code / Agent Skill A/B/D/F against the open static safety litmus (${SKILL_METHODOLOGY_VERSION}).`,
  "A skill is a SKILL.md (instructions + frontmatter) plus an optional bundle. The",
  "litmus scans the bytes for S-01 prompt-injection / context-poisoning in the body,",
  "S-03 data-exfiltration instructions, and S-04 dangerous commands in bundled",
  "executable scripts. It content-hashes the whole directory (the anti-tamper anchor).",
  "",
  "The SAFETY letter is a STATIC read: it does NOT execute the skill or its scripts",
  "and is fast — therefore NOT behavioral proof. An A means the static checks found no",
  "injection, exfil instruction, or dangerous bundled command, not that the skill is",
  "safe to run unsupervised. A command a skill constructs or fetches at runtime is not",
  "visible to static scanning (a disclosed limit).",
  "",
  "It also returns a SEPARATE, advisory `quality` signal (well-formed / issues /",
  "malformed) — never an A–F letter, never minted, never affecting the safety letter.",
  "Its deterministic checks always run; its optional LLM-judged axes (honesty,",
  "coherence) run only when a judge is available — the host agent's own model via MCP",
  "sampling (no key), or a user-provided OpenAI-compatible key — and are skipped",
  "otherwise.",
  "",
  "skill_ref: a local path to a skill directory containing SKILL.md (e.g.",
  "./skills/my-skill), OR a public GitHub skill: a github.com URL to the skill",
  "folder or its SKILL.md (blob/tree links work), or github/<owner>/<repo>#<path>.",
  "Remote skills are downloaded over TLS and scanned locally — still no execution.",
].join("\n");

export const runSkillLitmusInputShape = {
  skill_ref: z
    .string()
    .min(1)
    .max(1024)
    .describe(
      "Local path to a skill directory (must contain SKILL.md), or a public GitHub skill: a github.com blob/tree URL, or github/<owner>/<repo>#<path>.",
    ),
};

/** Optional judge for the advisory quality axes. Resolved per-call by mcp.ts
 *  (host-agent sampling if available, else an env key) — null ⇒ deterministic
 *  quality only. The litmus core never requires a key. */
export interface RunSkillLitmusContext {
  judge?: Judge | null;
}

export async function handleRunSkillLitmus({ skill_ref }: { skill_ref: string }, ctx: RunSkillLitmusContext = {}) {
  // Remote github refs are fetched to a temp dir and scanned there; the bundle
  // records the canonical ref (github/<owner>/<repo>#<path>), not the temp path.
  let resolved;
  try {
    resolved = await resolveSkillDir(skill_ref);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
  try {
    // Safety letter (deterministic) and the SEPARATE advisory quality signal.
    const safety = runSkillLitmus(resolved.dir, { skillRef: resolved.skillRef });
    const quality = ctx.judge
      ? await runSkillQualityJudged(resolved.dir, ctx.judge, { skillRef: resolved.skillRef })
      : runSkillQuality(resolved.dir, { skillRef: resolved.skillRef });
    return { content: [{ type: "text" as const, text: JSON.stringify({ safety: summarize(safety), quality: summarizeQuality(quality) }, null, 2) }] };
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  } finally {
    resolved.cleanup();
  }
}

function errorResult(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `run_skill_litmus failed: ${message}` }] };
}

function summarize(b: SkillEvidenceBundle) {
  const categories = b.categories.map((c) => ({
    code: c.code,
    check: SKILL_CATEGORY_META[c.code]?.label ?? c.code,
    description: SKILL_CATEGORY_META[c.code]?.description ?? null,
    status: c.status,
    reason: c.reason ?? null,
    findings:
      c.status === "fail"
        ? c.findings
            .filter((f) => f.severity === "high")
            .slice(0, 5)
            .map((f) => ({ kind: f.kind, match: truncate(f.match, 120), file: f.file }))
        : [],
  }));
  return {
    grade: b.grade,
    summary: b.gradeRationale,
    skillRef: b.skillRef,
    contentHash: b.contentHash,
    ranAt: b.ranAt,
    methodologyVersion: b.methodologyVersion,
    categories,
    advisories: b.advisories.slice(0, 10).map((f) => ({ kind: f.kind, severity: f.severity, match: truncate(f.match, 120), file: f.file })),
    disclaimer: b.disclaimer,
  };
}

function summarizeQuality(q: QualityBundle) {
  return {
    qualityVersion: q.qualityVersion,
    verdict: q.verdict, // well-formed | issues | malformed — NOT an A–F letter
    checks: q.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
    judged: q.judged
      ? { judge: q.judged.judge, samples: q.judged.samples, agreement: q.judged.agreement, axes: q.judged.axes }
      : null,
    disclaimer: q.disclaimer,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
