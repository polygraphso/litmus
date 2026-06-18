/**
 * The `→ ` output voice for a litmus result (mirrors core's CLI). Plain, exact,
 * no hype — the grade plus its reasons.
 */

import { CATEGORY_META, type EvidenceBundle } from "@polygraph/core";

export function formatBundle(b: EvidenceBundle): string {
  const lines: string[] = [];

  lines.push(`→ ${b.methodologyVersion} · ${b.serverRef}`);
  if (b.resolvedVersion) lines.push(`→ version ${b.resolvedVersion}`);
  // The server's own claim about its version — self-asserted, not a re-fetchable
  // pin, so it's flagged unverified to keep it distinct from the resolved pin.
  if (b.selfReportedVersion) lines.push(`→ self-reported ${b.selfReportedVersion} (unverified)`);

  // Each check as `code  label  status`, with a one-line gloss beneath — legible
  // without knowing the probe IDs. Only the categories the bundle actually ran.
  lines.push("→ checks");
  const labelWidth = Math.max(0, ...b.categories.map((c) => CATEGORY_META[c.code].label.length));
  for (const c of b.categories) {
    const { label, description } = CATEGORY_META[c.code];
    lines.push(`    ${c.code}  ${label.padEnd(labelWidth)}  ${c.status}`);
    lines.push(`          ${description}`);
  }

  const c01 = b.categories.find((c) => c.code === "C-01");
  if (c01?.status === "fail") {
    const highs = c01.probes.flatMap((p) => p.findings).filter((f) => f.severity === "high");
    for (const f of highs.slice(0, 3)) {
      lines.push(`   ⚠ ${f.tool ?? "?"}: ${f.kind} — ${truncate(f.match, 64)}`);
    }
  }

  lines.push(`→ fingerprint ${shortFp(b.toolDefsFingerprint)}`);
  lines.push(`→ grade: ${b.grade}`);
  lines.push(`   ${b.gradeRationale}`);
  return lines.join("\n") + "\n";
}

function shortFp(fp: string): string {
  return fp.length > 14 ? `${fp.slice(0, 6)}…${fp.slice(-4)}` : fp;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
