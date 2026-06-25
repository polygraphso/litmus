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

export type TargetKind = "server" | "skill";

export interface CiOptions {
  servers: string[];
  skills?: string[];
  discover: boolean;
  cwd: string;
  minGrade?: LitmusGrade;
  strict: boolean;
  lookup: boolean;
  bearer?: string;
  json: boolean;
}

export interface TargetSpec {
  kind: TargetKind;
  display: string;
  name?: string;
  /** server: ref or null (unmappable); skill: the dir path (never null). */
  ref: string | null;
}

export interface CiResult {
  kind: TargetKind;
  display: string;
  name?: string;
  grade: LitmusGrade | null;
  source: GradeSource;
  gated: boolean;
  reason: string;
}

export type Grader = (
  spec: TargetSpec,
  opts: { lookup: boolean; bearer?: string },
) => Promise<{ grade: LitmusGrade | null; source: GradeSource }>;

const VALID_GRADES = new Set(["A", "B", "C", "D", "F"]);

const CI_HELP = `polygraphso ci — gate a build on the polygraph grade of its MCP dependencies.

usage:
  polygraphso ci [--server <ref>]… [--min-grade <A|B|C|D>] [--strict]
                 [--no-discover] [--no-lookup] [--cwd <dir>] [--bearer <token>] [--json]

Discovers MCP servers from .mcp.json / .vscode/mcp.json / .cursor/mcp.json (unless
--no-discover) and/or explicit --server refs. Fails (exit 1) on any D/F grade (or below
--min-grade); un-gradeable dependencies warn unless --strict.
`;

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
      else process.stderr.write(`polygraphso ci: ignoring invalid --min-grade "${v}" (expected A|B|C|D|F)\n`);
    } else if (a.startsWith("-")) { /* ignore unknown flags */ }
    else o.servers.push(a); // bare positional = explicit ref
  }
  return o;
}

/** Final target list = discovered ∪ explicit, deduped by (kind, ref). Explicit wins. */
export function resolveSpecs(opts: CiOptions): TargetSpec[] {
  const specs: TargetSpec[] = [];
  const seen = new Set<string>();
  const push = (s: TargetSpec) => {
    const key = `${s.kind}:${s.ref ?? `~unmappable:${s.display}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    specs.push(s);
  };
  for (const ref of opts.servers) push({ kind: "server", display: ref, ref });
  if (opts.discover) {
    for (const d of discoverTargets(opts.cwd)) {
      push({ kind: "server", display: d.ref ?? d.raw, name: d.name, ref: d.ref });
    }
  }
  return specs;
}

/** Grade a server: hybrid published lookup → lazy live harness; ungradeable on error. */
async function gradeServer(
  ref: string | null,
  opts: { lookup: boolean; bearer?: string },
): Promise<{ grade: LitmusGrade | null; source: GradeSource }> {
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
}

/** Default grader. Servers: hybrid lookup → live harness. (Skills: added in the next change.) */
export const defaultGrader: Grader = async (spec, opts) => gradeServer(spec.ref, opts);

export async function evaluate(opts: CiOptions, grade: Grader = defaultGrader): Promise<CiResult[]> {
  const specs = resolveSpecs(opts);
  const results: CiResult[] = [];
  for (const spec of specs) {
    // A throwing grader must not abort the rest of the run — one bad target
    // degrades to ungradeable; the remaining targets are still graded.
    let g: LitmusGrade | null;
    let source: GradeSource;
    try {
      ({ grade: g, source } = await grade(spec, { lookup: opts.lookup, bearer: opts.bearer }));
    } catch {
      g = null;
      source = "ungradeable";
    }
    const verdict: GateResult = gate({ grade: g, source }, { minGrade: opts.minGrade, strict: opts.strict });
    results.push({ kind: spec.kind, display: spec.display, name: spec.name, grade: g, source, gated: verdict.gated, reason: verdict.reason });
  }
  return results;
}

export function renderSummary(results: CiResult[]): string {
  const rows = results.map((r) => {
    const verdict = r.gated ? "FAIL" : r.source === "ungradeable" ? "warn" : "pass";
    return `| ${r.kind} | ${r.display} | ${r.grade ?? "—"} | ${r.source} | ${verdict} |`;
  });
  return [
    "### Polygraph gate",
    "",
    "| Kind | Target | Grade | Source | Verdict |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Collapse newlines so a config-derived display/reason can't forge an extra annotation line. */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ");

function emitGitHub(results: CiResult[]): void {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSummary(results) + "\n");
  }
  if (process.env.GITHUB_ACTIONS) {
    for (const r of results) {
      if (r.gated) process.stdout.write(`::error::polygraph: ${oneLine(r.display)} — ${oneLine(r.reason)}\n`);
      else if (r.source === "ungradeable") process.stdout.write(`::warning::polygraph: ${oneLine(r.display)} — ${oneLine(r.reason)}\n`);
    }
  }
  if (process.env.GITHUB_OUTPUT) {
    const failed = results.filter((r) => r.gated).length;
    const report = JSON.stringify(results.map((r) => ({ kind: r.kind, target: r.display, grade: r.grade, source: r.source, gated: r.gated, reason: r.reason })));
    appendFileSync(process.env.GITHUB_OUTPUT, `result=${failed > 0 ? "fail" : "pass"}\nfailed=${failed}\nreport=${report}\n`);
  }
}

export async function runCi(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(CI_HELP);
    return 0;
  }
  const opts = parseCiArgs(args);
  const results = await evaluate(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(results) + "\n");
  } else {
    const plain = renderSummary(results)
      .split("\n")
      .filter((l) => !l.startsWith("| ---"))
      .map((l) => l.replace(/\| /g, "").replace(/ \|/g, ""))
      .join("\n");
    process.stderr.write(plain + "\n");
  }
  emitGitHub(results);
  return results.some((r) => r.gated) ? 1 : 0;
}
