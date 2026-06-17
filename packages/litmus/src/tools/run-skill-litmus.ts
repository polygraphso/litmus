/**
 * `run_skill_litmus` — run the deterministic static safety litmus over a Claude
 * Code / Agent Skill (a SKILL.md + bundle) and return the grade + evidence.
 *
 * Unlike `run_litmus` (which LAUNCHES an MCP server's code), this is a pure STATIC
 * read of the skill's text and bundled files — no execution, no network. That is
 * also its disclosed limit: a static A is not behavioral proof. v1 grades a LOCAL
 * skill directory; remote refs (github/marketplace) come with the onchain phase.
 */

import { z } from "zod";
import { statSync } from "node:fs";
import { runSkillLitmus, SKILL_METHODOLOGY_VERSION, type SkillEvidenceBundle } from "@polygraph/probes";

export const RUN_SKILL_LITMUS_TOOL_NAME = "run_skill_litmus";
export const RUN_SKILL_LITMUS_TOOL_TITLE = "Run a safety litmus on a Claude Code skill";
export const RUN_SKILL_LITMUS_TOOL_DESCRIPTION = [
  `Grade a Claude Code / Agent Skill A/B/D/F against the open static safety litmus (${SKILL_METHODOLOGY_VERSION}).`,
  "A skill is a SKILL.md (instructions + frontmatter) plus an optional bundle. The",
  "litmus scans the bytes for S-01 prompt-injection / context-poisoning in the body,",
  "S-03 data-exfiltration instructions, and S-04 dangerous commands in bundled",
  "executable scripts. It content-hashes the whole directory (the anti-tamper anchor).",
  "",
  "This is a STATIC read: it does NOT execute the skill or its scripts, makes no",
  "network calls, and is fast. It is therefore NOT behavioral proof — an A means the",
  "static checks found no injection, exfil instruction, or dangerous bundled command,",
  "not that the skill is safe to run unsupervised. A command a skill constructs or",
  "fetches at runtime is not visible to static scanning (a disclosed limit).",
  "",
  "skill_ref (v1): a LOCAL path to a skill directory containing SKILL.md, e.g.",
  "./skills/my-skill. Remote refs (github/<owner>/<repo>#path, marketplace/<owner>/<name>)",
  "are not yet supported.",
].join("\n");

export const runSkillLitmusInputShape = {
  skill_ref: z
    .string()
    .min(1)
    .max(1024)
    .describe("Local path to a skill directory (must contain SKILL.md). Remote refs are not yet supported in this version."),
};

export async function handleRunSkillLitmus({ skill_ref }: { skill_ref: string }) {
  try {
    let st;
    try {
      st = statSync(skill_ref);
    } catch {
      return errorResult(`no such path: ${skill_ref} (v1 grades a local skill directory; remote refs are not yet supported)`);
    }
    if (!st.isDirectory()) {
      return errorResult(`not a directory: ${skill_ref} (pass the skill folder that contains SKILL.md)`);
    }
    const bundle = runSkillLitmus(skill_ref, { skillRef: skill_ref });
    return { content: [{ type: "text" as const, text: JSON.stringify(summarize(bundle), null, 2) }] };
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

function errorResult(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `run_skill_litmus failed: ${message}` }] };
}

const CATEGORY_LABEL: Record<string, string> = {
  "S-01": "prompt injection / context poisoning",
  "S-03": "data-exfiltration instructions",
  "S-04": "dangerous bundled commands",
};

function summarize(b: SkillEvidenceBundle) {
  const categories = b.categories.map((c) => ({
    code: c.code,
    check: CATEGORY_LABEL[c.code] ?? c.code,
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

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
