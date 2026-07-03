#!/usr/bin/env node
/**
 * `polygraphso-litmus-skill` — static safety grades for Claude Code / Agent Skills.
 *
 * Grades a skill directory (a SKILL.md + bundle) A/B/D/F by scanning its bytes —
 * no execution. Takes a local path or a public GitHub skill (URL or
 * github/<owner>/<repo>#<path>), downloaded and scanned locally. The companion to
 * `polygraphso-litmus` (which grades MCP servers). A static A is not behavioral
 * proof; see the printed note.
 */

import { resolveSkillDir } from "./skill-remote.js";
import {
  runSkillLitmus,
  runSkillQuality,
  runSkillQualityJudged,
  judgeFromEnv,
  type QualityBundle,
} from "@polygraph/probes";
import { formatSkillSafety } from "./format-skill.js";

const HELP = `polygraphso-litmus-skill — static safety grades for Claude Code skills.

usage:
  polygraphso-litmus-skill [--json] <path-to-skill-dir>
  polygraphso-litmus-skill [--json] <github-skill-url | github/<owner>/<repo>#<path>>
  polygraphso-litmus-skill --help

The skill dir must contain a SKILL.md. A public GitHub skill (a github.com URL
to the skill folder or its SKILL.md, or github/<owner>/<repo>#<path>) is
downloaded and scanned locally. The safety letter is a STATIC scan (no
execution); an A means the static checks were clean, not that the skill is
behaviorally safe.

It also prints a separate, advisory quality signal. The optional LLM-judged
axes (honesty, coherence) run only if you provide your own key — set
LITMUS_LLM_API_KEY and LITMUS_LLM_MODEL (and LITMUS_LLM_BASE_URL for a non-OpenAI
endpoint). Without a key only the deterministic well-formedness checks run.
More at https://polygraph.so
`;

function renderQuality(q: QualityBundle): string {
  const lines = ["", `quality (advisory, separate from the grade): ${q.verdict}`];
  for (const c of q.checks) lines.push(`  ${c.status === "pass" ? "·" : "!"} ${c.id}: ${c.detail}`);
  if (q.judged) {
    lines.push(`  judged by ${q.judged.judge} (${q.judged.samples} sample(s), agreement ${q.judged.agreement}):`);
    for (const a of q.judged.axes) lines.push(`    - ${a.axis}: ${a.rating}`);
  } else {
    lines.push("  (LLM-judged axes not run — no key/sampling; set LITMUS_LLM_API_KEY + LITMUS_LLM_MODEL to enable)");
  }
  return lines.join("\n") + "\n";
}

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.filter((a) => a !== "--json");
  const json = argv.includes("--json");
  const target = args[0];

  if (!target || target === "--help" || target === "-h" || target === "help") {
    process.stdout.write(HELP);
    return target ? 0 : 2;
  }

  let resolved;
  try {
    resolved = await resolveSkillDir(target);
  } catch (err) {
    process.stderr.write(`polygraphso-litmus-skill: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  try {
    const safety = runSkillLitmus(resolved.dir, { skillRef: resolved.skillRef });
    const judge = judgeFromEnv();
    const quality = judge
      ? await runSkillQualityJudged(resolved.dir, judge, { skillRef: resolved.skillRef })
      : runSkillQuality(resolved.dir, { skillRef: resolved.skillRef });

    process.stdout.write(
      json ? JSON.stringify({ safety, quality }, null, 2) + "\n" : formatSkillSafety(safety) + renderQuality(quality),
    );
    return 0;
  } finally {
    resolved.cleanup();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`polygraphso-litmus-skill: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
