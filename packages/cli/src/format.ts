/**
 * The `→ ` output voice for a litmus result (mirrors core's CLI). Plain, exact,
 * no hype — the grade plus its reasons.
 */

import { CATEGORY_META, type DependencyAudit, type EvidenceBundle } from "@polygraph/core";

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

/**
 * The advisory dependency audit, rendered beneath the grade. Deliberately framed
 * as point-in-time and NOT part of the grade — it scans the server's npm
 * dependency tree against osv.dev, which changes over time, so it never enters
 * the reproducible verdict or the minted evidence.
 */
export function formatDependencyAudit(a: DependencyAudit): string {
  const HEADER = "→ dependency advisories — point-in-time, source: osv.dev, not part of the grade";
  if (a.status === "skipped") {
    return `→ dependency advisories — skipped: ${a.reason ?? "not available"} (source: osv.dev, not part of the grade)\n`;
  }

  const lines: string[] = [HEADER];
  const deps = `${a.dependencyCount} npm ${a.dependencyCount === 1 ? "dependency" : "dependencies"}`;
  if (a.advisories.length === 0) {
    lines.push(`   audited ${deps} · no known advisories`);
    return lines.join("\n") + "\n";
  }

  lines.push(
    `   audited ${deps} · ${a.vulnerableCount} with known ${a.vulnerableCount === 1 ? "advisory" : "advisories"}`,
  );
  const shown = a.advisories.slice(0, 10);
  // Band, with the CVSS score appended when published (e.g. "CRITICAL 9.8").
  const band = (f: (typeof shown)[number]): string =>
    `${f.severity.toUpperCase()}${f.cvss !== undefined ? ` ${f.cvss}` : ""}`;
  const bandWidth = Math.max(...shown.map((f) => band(f).length));
  const refWidth = Math.max(...shown.map((f) => `${f.package}@${f.version}`.length));
  for (const f of shown) {
    const ref = `${f.package}@${f.version}`.padEnd(refWidth);
    const fix = f.fixedIn ? `  (fix: ${f.fixedIn})` : "";
    const summary = f.summary ? `  ${truncate(f.summary, 56)}` : "";
    lines.push(`   ! ${band(f).padEnd(bandWidth)}  ${ref}  ${f.id}${summary}${fix}`);
  }
  if (a.advisories.length > shown.length) {
    lines.push(`   … ${a.advisories.length - shown.length} more.`);
  }
  lines.push("   Advisory only — does not affect the A–F grade or the minted evidence.");
  return lines.join("\n") + "\n";
}

function shortFp(fp: string): string {
  return fp.length > 14 ? `${fp.slice(0, 6)}…${fp.slice(-4)}` : fp;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
