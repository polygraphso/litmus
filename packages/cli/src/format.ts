/**
 * The `→ ` output voice for a litmus result (mirrors core's CLI). Plain, exact,
 * no hype — the grade plus its reasons.
 */

import type { EvidenceBundle } from "@polygraph/core";

export function formatBundle(b: EvidenceBundle): string {
  const status = (code: string) => b.categories.find((c) => c.code === code)?.status ?? "?";
  const lines: string[] = [];

  lines.push(`→ ${b.methodologyVersion} · ${b.serverRef}`);
  lines.push(`→ C-01 ${status("C-01")} · C-02 ${status("C-02")} · C-03 ${status("C-03")}`);

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
