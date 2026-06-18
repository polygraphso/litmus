/**
 * The human render of a skill safety grade for `polygraphso-litmus-skill`. Kept
 * in its own (non-executing) module so it can be unit-tested without running the
 * bin. Each S-code carries a plain-English label and a one-line gloss, so the
 * output is legible without knowing the probe IDs.
 */

import { SKILL_CATEGORY_META, type SkillEvidenceBundle } from "@polygraph/probes";

export function formatSkillSafety(b: SkillEvidenceBundle): string {
  const lines = [
    `grade: ${b.grade}  (${b.methodologyVersion})`,
    `${b.gradeRationale}`,
    `skill:   ${b.skillRef}`,
    `hash:    ${b.contentHash}`,
    "",
    "categories:",
  ];
  const labelWidth = Math.max(0, ...b.categories.map((c) => SKILL_CATEGORY_META[c.code].label.length));
  for (const c of b.categories) {
    const { label, description } = SKILL_CATEGORY_META[c.code];
    lines.push(`  ${c.code}  ${label.padEnd(labelWidth)}  ${c.status}${c.reason ? `  (${c.reason})` : ""}`);
    lines.push(`        ${description}`);
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
