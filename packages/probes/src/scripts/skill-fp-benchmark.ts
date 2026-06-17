/**
 * Phase 0 gate (skills-litmus): empirical false-positive benchmark.
 *
 * Runs the EXISTING C-01 text scanners (the ones the skill safety letter would
 * reuse for S-01) over a corpus of real, known-good published skills and reports
 * how many would be FALSE-FAILED (any HIGH finding => F under the proposed
 * HIGH-only bar). It compares scanning the raw SKILL.md body vs. a body with
 * fenced code, inline code, and blockquoted example transcripts stripped — the
 * recalibration the design proposes.
 *
 * The point: the HIGH MIMICRY patterns (`system:`, role tags, `"tool_call":`) and
 * the markdown `javascript:`/`data:` rule were calibrated for honest *tool docs*
 * ("rare in honest tool docs", scanners.ts:40-46). Skill bodies are a different
 * distribution. If legitimate skills trip HIGH, the rubric must recalibrate before
 * it is written. This script produces that evidence; it grades nothing.
 *
 * Run:  node --import tsx ./src/scripts/skill-fp-benchmark.ts [rootDir ...]
 * Default root: ~/.claude/plugins/cache
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Finding } from "@polygraph/core";
import { instructionMimicry, invisibleUnicode, markdownTricks } from "../probes/scanners.js";
import { skillInjection, exfilInstruction, dangerousCommand } from "../skills/scanners-skill.js";

const EXEC_EXT = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php)$/i;
function isExecutableFile(path: string): boolean {
  if (EXEC_EXT.test(path)) return true;
  try {
    const head = readFileSync(path).subarray(0, 2).toString("utf8");
    return head === "#!";
  } catch {
    return false;
  }
}
function executableFilesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".git")) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (isExecutableFile(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

type Mode = "raw" | "stripped";

function findSkillFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".git")) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.toLowerCase() === "skill.md") out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Split leading YAML frontmatter (`---\n…\n---`) from the markdown body. */
function splitFrontmatter(src: string): { frontmatter: string; body: string } {
  if (!src.startsWith("---")) return { frontmatter: "", body: src };
  const end = src.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: "", body: src };
  const close = src.indexOf("\n", end + 1);
  return {
    frontmatter: src.slice(src.indexOf("\n") + 1, end),
    body: close < 0 ? "" : src.slice(close + 1),
  };
}

/** Strip fenced code, inline code, and blockquoted lines — the example/transcript
 *  surface where role tags / `system:` / tool-call JSON legitimately appear. */
function stripExamples(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

/** Coarse label for a HIGH finding so we can see WHICH pattern fires. */
function labelOf(f: Finding): string {
  const m = f.match;
  if (f.kind === "invisible-unicode") return "invisible-unicode";
  if (f.kind === "markdown-trick") {
    return /^(?:javascript|data):/i.test(m) ? "md:js/data-uri" : "md:exfil-query";
  }
  // instruction-mimicry
  if (/system\s*:/i.test(m) && !/[<]/.test(m)) return "mimicry:system:";
  if (/^<\/?(?:system|assistant|user|tool)\b/i.test(m)) return "mimicry:role-tag";
  if (/(?:tool_call|function_call|tool_name|function)/i.test(m)) return "mimicry:tool-call-json";
  if (/ignore|disregard|previous|prior|new\s|updated|revised/i.test(m)) return "mimicry:override";
  return "mimicry:other";
}

function highFindings(text: string): Finding[] {
  return [
    ...invisibleUnicode(text),
    ...instructionMimicry(text),
    ...markdownTricks(text),
  ].filter((f) => f.severity === "high");
}

function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) roots.push(join(homedir(), ".claude", "plugins", "cache"));

  // Collect distinct skills (dedupe identical files copied across cache/marketplace).
  const seen = new Set<string>();
  const skills: { path: string; dir: string; body: string }[] = [];
  for (const root of roots) {
    for (const file of findSkillFiles(root)) {
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const h = createHash("sha256").update(src).digest("hex");
      if (seen.has(h)) continue;
      seen.add(h);
      skills.push({ path: file, dir: dirname(file), body: splitFrontmatter(src).body });
    }
  }

  const failed: Record<Mode, Set<number>> = { raw: new Set(), stripped: new Set() };
  const byLabel: Record<Mode, Map<string, { count: number; examples: string[] }>> = {
    raw: new Map(),
    stripped: new Map(),
  };

  const bump = (mode: Mode, label: string, example: string) => {
    const e = byLabel[mode].get(label) ?? { count: 0, examples: [] };
    e.count += 1;
    if (e.examples.length < 4) e.examples.push(example);
    byLabel[mode].set(label, e);
  };

  skills.forEach((s, i) => {
    for (const mode of ["raw", "stripped"] as const) {
      const text = mode === "raw" ? s.body : stripExamples(s.body);
      const found = highFindings(text);
      if (found.length > 0) failed[mode].add(i);
      const labels = new Set(found.map(labelOf));
      for (const f of found) bump(mode, labelOf(f), `${shortName(s.path)} :: ${JSON.stringify(f.match)}`);
      void labels;
    }
  });

  const N = skills.length;
  const pct = (n: number) => `${n}/${N} (${((100 * n) / Math.max(N, 1)).toFixed(1)}%)`;

  console.log(`\n=== Skill FP benchmark — ${N} distinct skills ===`);
  for (const mode of ["raw", "stripped"] as const) {
    console.log(`\n[${mode.toUpperCase()}] would FALSE-FAIL (any HIGH => F): ${pct(failed[mode].size)}`);
    const labels = [...byLabel[mode].entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [label, { count, examples }] of labels) {
      console.log(`  ${label.padEnd(22)} ${String(count).padStart(4)} hits`);
      for (const ex of examples) console.log(`      e.g. ${ex}`);
    }
    if (labels.length === 0) console.log("  (no HIGH findings)");
  }
  console.log(
    `\nDelta (raw -> stripped): ${failed.raw.size} -> ${failed.stripped.size} false-fails ` +
      `(${failed.raw.size - failed.stripped.size} fixed by code/example stripping)\n`,
  );

  // ── Recalibrated S-01 + net-new S-03 / S-04, as they would actually grade ──
  const recalS01 = new Set<number>();
  const s03 = new Set<number>();
  const s04 = new Set<number>();
  let execFileCount = 0;
  const s04ex: string[] = [];
  const s03ex: string[] = [];
  skills.forEach((s, i) => {
    if (skillInjection(s.body).some((f) => f.severity === "high")) recalS01.add(i);
    if (exfilInstruction(s.body).some((f) => f.severity === "high")) {
      s03.add(i);
      if (s03ex.length < 6) s03ex.push(shortName(s.path));
    }
    for (const f of executableFilesIn(s.dir)) {
      execFileCount++;
      let src = "";
      try {
        src = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      if (dangerousCommand(src, f).some((x) => x.severity === "high")) {
        s04.add(i);
        if (s04ex.length < 6) s04ex.push(`${shortName(s.path)} [${f.split("/").pop()}]`);
      }
    }
  });
  console.log("=== As-graded false-positive rates (the actual skill scanners) ===");
  console.log(`  S-01 (recalibrated, F)      false-fails: ${pct(recalS01.size)}`);
  console.log(`  S-03 (exfil instr, F)       false-fails: ${pct(s03.size)}${s03ex.length ? `  e.g. ${s03ex.join(", ")}` : ""}`);
  console.log(`  S-04 (dangerous cmd, D)     false-fails: ${pct(s04.size)} over ${execFileCount} executable files${s04ex.length ? `  e.g. ${s04ex.join(", ")}` : ""}`);
  console.log("");
}

function shortName(p: string): string {
  const parts = p.split("/");
  const i = parts.lastIndexOf("skills");
  return i >= 0 ? parts.slice(i + 1).join("/") : parts.slice(-2).join("/");
}

main();
