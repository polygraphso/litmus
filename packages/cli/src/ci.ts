/**
 * `polygraphso ci` — gate a build on the polygraph grade of its MCP dependencies.
 * Hybrid: a fast published-grade lookup first, then the behavioral harness when a
 * dependency is ungraded. Fails (exit 1) on any D/F (or a configurable minimum);
 * un-gradeable deps warn unless --strict. Targets come from MCP config discovery
 * and/or explicit --server refs. CI-agnostic — emits GitHub job summary,
 * annotations, and outputs only when the matching env vars are present.
 */
import { appendFileSync } from "node:fs";
import type { LitmusGrade } from "@polygraph/core";
import { gate, type GateResult, type GradeSource } from "./ci-policy.js";
import { discoverTargets } from "./ci-discover.js";
import { lookupPublishedGrade } from "./check.js";
import { resolveTarget, DEFAULT_RUN_TIMEOUT_MS } from "./litmus.js";

export interface CiOptions {
  servers: string[];
  discover: boolean;
  cwd: string;
  minGrade?: LitmusGrade;
  strict: boolean;
  lookup: boolean;
  bearer?: string;
  json: boolean;
}

export interface CiResult {
  display: string;
  name?: string;
  grade: LitmusGrade | null;
  source: GradeSource;
  gated: boolean;
  reason: string;
}

export type Grader = (
  ref: string | null,
  opts: { lookup: boolean; bearer?: string },
) => Promise<{ grade: LitmusGrade | null; source: GradeSource }>;

const VALID_GRADES = new Set(["A", "B", "C", "D", "F"]);

export function parseCiArgs(args: readonly string[]): CiOptions {
  const o: CiOptions = { servers: [], discover: true, cwd: ".", strict: false, lookup: true, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-discover") o.discover = false;
    else if (a === "--no-lookup") o.lookup = false;
    else if (a === "--strict") o.strict = true;
    else if (a === "--json") o.json = true;
    else if (a === "--cwd") o.cwd = args[++i] ?? ".";
    else if (a === "--bearer") o.bearer = args[++i];
    else if (a === "--server") { const v = args[++i]; if (v) o.servers.push(v); }
    else if (a === "--min-grade") {
      const v = (args[++i] ?? "").toUpperCase();
      if (VALID_GRADES.has(v)) o.minGrade = v as LitmusGrade;
    } else if (a.startsWith("-")) { /* ignore unknown flags */ }
    else o.servers.push(a); // bare positional = explicit ref
  }
  return o;
}

/** Final target list = discovered ∪ explicit, deduped by ref (explicit wins). */
export function resolveSpecs(opts: CiOptions): { display: string; name?: string; ref: string | null }[] {
  const specs: { display: string; name?: string; ref: string | null }[] = [];
  const seen = new Set<string>();
  const push = (s: { display: string; name?: string; ref: string | null }) => {
    const key = s.ref ?? `~unmappable:${s.display}`;
    if (seen.has(key)) return;
    seen.add(key);
    specs.push(s);
  };
  for (const ref of opts.servers) push({ display: ref, ref });
  if (opts.discover) {
    for (const d of discoverTargets(opts.cwd)) {
      push({ display: d.ref ?? d.raw, name: d.name, ref: d.ref });
    }
  }
  return specs;
}

/** Default grader: lookup (if enabled) then live harness; else un-gradeable. */
export const defaultGrader: Grader = async (ref, opts) => {
  if (ref === null) return { grade: null, source: "ungradeable" };
  if (opts.lookup) {
    const pub = await lookupPublishedGrade(ref);
    if (pub) return { grade: pub.grade, source: "published" };
  }
  try {
    const { runLitmus } = await import("@polygraph/probes"); // lazy: keep fast path clean
    const isHttp = /^https?:\/\//i.test(ref);
    const bundle = await runLitmus(resolveTarget(ref), {
      isolation: process.env.LITMUS_STDIO_ISOLATION === "docker" ? "docker" : "none",
      timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
      ...(isHttp && opts.bearer ? { headers: { Authorization: `Bearer ${opts.bearer}` } } : {}),
    });
    return { grade: bundle.grade, source: "live" };
  } catch {
    return { grade: null, source: "ungradeable" };
  }
};

export async function evaluate(opts: CiOptions, grade: Grader = defaultGrader): Promise<CiResult[]> {
  const specs = resolveSpecs(opts);
  const results: CiResult[] = [];
  for (const spec of specs) {
    const { grade: g, source } = await grade(spec.ref, { lookup: opts.lookup, bearer: opts.bearer });
    const verdict: GateResult = gate({ grade: g, source }, { minGrade: opts.minGrade, strict: opts.strict });
    results.push({ display: spec.display, name: spec.name, grade: g, source, gated: verdict.gated, reason: verdict.reason });
  }
  return results;
}

export function renderSummary(results: CiResult[]): string {
  const rows = results.map((r) => {
    const verdict = r.gated ? "FAIL" : r.source === "ungradeable" ? "warn" : "pass";
    return `| ${r.display} | ${r.grade ?? "—"} | ${r.source} | ${verdict} |`;
  });
  return [
    "### Polygraph MCP gate",
    "",
    "| Server | Grade | Source | Verdict |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function emitGitHub(results: CiResult[]): void {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSummary(results) + "\n");
  }
  if (process.env.GITHUB_ACTIONS) {
    for (const r of results) {
      if (r.gated) process.stdout.write(`::error::polygraph: ${r.display} — ${r.reason}\n`);
      else if (r.source === "ungradeable") process.stdout.write(`::warning::polygraph: ${r.display} — ${r.reason}\n`);
    }
  }
  if (process.env.GITHUB_OUTPUT) {
    const failed = results.filter((r) => r.gated).length;
    const report = JSON.stringify(results.map((r) => ({ target: r.display, grade: r.grade, source: r.source, gated: r.gated })));
    appendFileSync(process.env.GITHUB_OUTPUT, `result=${failed > 0 ? "fail" : "pass"}\nfailed=${failed}\nreport=${report}\n`);
  }
}

export async function runCi(args: readonly string[]): Promise<number> {
  const opts = parseCiArgs(args);
  const results = await evaluate(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(results) + "\n");
  } else {
    process.stderr.write(renderSummary(results).replace(/\| /g, "").replace(/ \|/g, "") + "\n");
  }
  emitGitHub(results);
  return results.some((r) => r.gated) ? 1 : 0;
}
