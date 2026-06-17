#!/usr/bin/env node
/**
 * `polygraphso-litmus-skill` — static safety grades for Claude Code / Agent Skills.
 *
 * Grades a LOCAL skill directory (a SKILL.md + bundle) A/B/D/F by scanning its
 * bytes — no execution, no network. The companion to `polygraphso-litmus` (which
 * grades MCP servers). A static A is not behavioral proof; see the printed note.
 */

import { statSync } from "node:fs";
import { runSkillLitmus, type SkillEvidenceBundle } from "@polygraph/probes";

const HELP = `polygraphso-litmus-skill — static safety grades for Claude Code skills.

usage:
  polygraphso-litmus-skill [--json] <path-to-skill-dir>
  polygraphso-litmus-skill --help

The skill dir must contain a SKILL.md. This is a STATIC scan (no execution,
no network); an A means the static checks were clean, not that the skill is
behaviorally safe. More at https://polygraph.so
`;

function render(b: SkillEvidenceBundle): string {
  const lines = [
    `grade: ${b.grade}  (${b.methodologyVersion})`,
    `${b.gradeRationale}`,
    `skill:   ${b.skillRef}`,
    `hash:    ${b.contentHash}`,
    "",
    "categories:",
  ];
  for (const c of b.categories) {
    lines.push(`  ${c.code}  ${c.status}${c.reason ? `  (${c.reason})` : ""}`);
    if (c.status === "fail") {
      for (const f of c.findings.filter((x) => x.severity === "high").slice(0, 5)) {
        lines.push(`      ! ${f.kind}${f.file ? ` [${f.file}]` : ""}: ${f.match}`);
      }
    }
  }
  if (b.advisories.length) {
    lines.push("", "advisories (not part of the grade):");
    for (const f of b.advisories.slice(0, 10)) {
      lines.push(`  - ${f.kind} (${f.severity})${f.file ? ` [${f.file}]` : ""}: ${f.match}`);
    }
  }
  lines.push("", b.disclaimer);
  return lines.join("\n") + "\n";
}

function main(argv: readonly string[]): number {
  const args = argv.filter((a) => a !== "--json");
  const json = argv.includes("--json");
  const target = args[0];

  if (!target || target === "--help" || target === "-h" || target === "help") {
    process.stdout.write(HELP);
    return target ? 0 : 2;
  }

  let st;
  try {
    st = statSync(target);
  } catch {
    process.stderr.write(`polygraphso-litmus-skill: no such path: ${target}\n`);
    return 2;
  }
  if (!st.isDirectory()) {
    process.stderr.write(`polygraphso-litmus-skill: not a directory: ${target} (pass the skill folder containing SKILL.md)\n`);
    return 2;
  }

  const bundle = runSkillLitmus(target, { skillRef: target });
  process.stdout.write(json ? JSON.stringify(bundle, null, 2) + "\n" : render(bundle));
  return 0;
}

process.exit(main(process.argv.slice(2)));
