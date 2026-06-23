/**
 * Advisory dependency audit (litmus add-on, NOT part of the A–F grade).
 *
 * For an npm target, resolve its full dependency tree and check every resolved
 * `{name, version}` against the OSV.dev known-vulnerability database, then report
 * any matches as advisories. This is deliberately kept OUTSIDE the behavioral
 * grade and the evidence bundle:
 *   - it is a supply-chain signal, not server behavior;
 *   - vulnerability databases change over time, so it is point-in-time and would
 *     break the "re-run the open harness to verify the same proof" guarantee if
 *     it entered the canonicalized/hashed bundle.
 * It is surfaced in CLI + MCP output only. Every failure path returns
 * `status: "skipped"` (mirroring the C-02 skip pattern) — it never throws and
 * never fails a grade.
 *
 * Resolution runs `npm install --package-lock-only --ignore-scripts`, which
 * resolves the tree and writes a lockfile WITHOUT downloading tarballs or
 * running any package code. The harness already reaches the npm registry to run
 * npm targets, so this is consistent egress, not a new class.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerRef } from "@polygraph/core";
import type { AdvisorySeverity, DependencyAdvisory, DependencyAudit } from "@polygraph/core";
import type { TargetInput } from "../harness.js";

const OSV_QUERYBATCH = "https://api.osv.dev/v1/querybatch";
const OSV_VULN = "https://api.osv.dev/v1/vulns/";

export interface AuditDependenciesOptions {
  /** A lockfile (path or raw contents) already produced elsewhere — e.g. the
   *  Docker staging install — to skip a second resolution. */
  existingLockfile?: string;
  /** Injected fetch (tests / custom transport). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected clock (tests). Defaults to the wall clock. */
  now?: () => string;
  /** Cap on dependencies queried (default 2000). */
  maxDeps?: number;
  /** Cap on advisories enriched with severity/summary (default 50). */
  maxEnrich?: number;
  /** Abort signal forwarded to npm + OSV calls. */
  signal?: AbortSignal;
  /** Timeout for the npm resolution (default 60s). */
  timeoutMs?: number;
  /** Override the dependency-tree resolver (test seam). */
  resolveLockfile?: (spec: string) => Promise<string | null>;
}

interface Dep {
  name: string;
  version: string;
}

const DEFAULT_MAX_DEPS = 2000;
const DEFAULT_MAX_ENRICH = 50;
const DEFAULT_TIMEOUT_MS = 60_000;

const SEVERITY_RANK: Record<AdvisorySeverity, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
  unknown: 4,
};

function skipped(reason: string, now: () => string): DependencyAudit {
  return {
    status: "skipped",
    reason,
    source: "osv.dev",
    ecosystem: "npm",
    queriedAt: now(),
    dependencyCount: 0,
    vulnerableCount: 0,
    advisories: [],
  };
}

/**
 * Flatten an npm lockfile (v2/v3 `packages` map, or v1 `dependencies` tree) into
 * a deduped list of `{name, version}`, excluding the root entry. Unparseable
 * input yields an empty list (the caller then skips).
 */
export function parseLockfile(content: string): Dep[] {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: Dep[] = [];
  const push = (name: string, version: unknown) => {
    if (!name || typeof version !== "string" || !version) return;
    const key = `${name}@${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, version });
  };

  const root = json as { packages?: Record<string, { version?: unknown }>; dependencies?: Record<string, unknown> };

  // Lockfile v2/v3: `packages` keyed by install path. Name is the segment after
  // the final `node_modules/`; the root package has key "".
  if (root.packages && typeof root.packages === "object") {
    for (const [path, entry] of Object.entries(root.packages)) {
      if (path === "") continue;
      const idx = path.lastIndexOf("node_modules/");
      if (idx === -1) continue;
      const name = path.slice(idx + "node_modules/".length);
      push(name, entry?.version);
    }
    return out.slice(0, DEFAULT_MAX_DEPS);
  }

  // Lockfile v1: recursive `dependencies` tree.
  if (root.dependencies && typeof root.dependencies === "object") {
    const walk = (deps: Record<string, { version?: unknown; dependencies?: Record<string, unknown> }>) => {
      for (const [name, entry] of Object.entries(deps)) {
        push(name, entry?.version);
        if (entry?.dependencies && typeof entry.dependencies === "object") {
          walk(entry.dependencies as Record<string, { version?: unknown }>);
        }
      }
    };
    walk(root.dependencies as Record<string, { version?: unknown }>);
  }
  return out.slice(0, DEFAULT_MAX_DEPS);
}

/** Map a GHSA-style band or a CVSS vector to a normalized advisory severity. */
function severityFromVuln(vuln: {
  database_specific?: { severity?: unknown };
  severity?: Array<{ type?: string; score?: string }>;
}): AdvisorySeverity {
  const band = vuln.database_specific?.severity;
  if (typeof band === "string") {
    const b = band.toUpperCase();
    if (b === "CRITICAL") return "critical";
    if (b === "HIGH") return "high";
    if (b === "MODERATE" || b === "MEDIUM") return "moderate";
    if (b === "LOW") return "low";
  }
  const cvss = vuln.severity?.find((s) => typeof s.score === "string" && s.score.startsWith("CVSS:"));
  if (cvss?.score) {
    const score = cvssBaseScore(cvss.score);
    if (score !== null) return bandFromScore(score);
  }
  return "unknown";
}

function bandFromScore(score: number): AdvisorySeverity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  if (score > 0) return "low";
  return "unknown";
}

/** Compute a CVSS v3.x base score from a vector string (spec §7.1). */
function cvssBaseScore(vector: string): number | null {
  const m = new Map<string, string>();
  for (const part of vector.split("/")) {
    const [k, v] = part.split(":");
    if (k && v) m.set(k, v);
  }
  const changed = m.get("S") === "C";
  const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
  const AC: Record<string, number> = { L: 0.77, H: 0.44 };
  const UI: Record<string, number> = { N: 0.85, R: 0.62 };
  const PR: Record<string, number> = changed
    ? { N: 0.85, L: 0.68, H: 0.5 }
    : { N: 0.85, L: 0.62, H: 0.27 };
  const CIA: Record<string, number> = { N: 0, L: 0.22, H: 0.56 };

  const av = AV[m.get("AV") ?? ""];
  const ac = AC[m.get("AC") ?? ""];
  const pr = PR[m.get("PR") ?? ""];
  const ui = UI[m.get("UI") ?? ""];
  const c = CIA[m.get("C") ?? ""];
  const i = CIA[m.get("I") ?? ""];
  const a = CIA[m.get("A") ?? ""];
  if (av === undefined || ac === undefined || pr === undefined || ui === undefined) return null;
  if (c === undefined || i === undefined || a === undefined) return null;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const raw = changed
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return Math.ceil(raw * 10) / 10;
}

/** POST the dependency list to OSV's batch endpoint; returns matches per dep. */
async function queryOsv(
  deps: Dep[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Array<{ dep: Dep; id: string }>> {
  const matches: Array<{ dep: Dep; id: string }> = [];
  // OSV pages vulns past 1000 per query; chunk the query list to stay well clear.
  for (let i = 0; i < deps.length; i += 1000) {
    const chunk = deps.slice(i, i + 1000);
    const body = {
      queries: chunk.map((d) => ({ package: { ecosystem: "npm", name: d.name }, version: d.version })),
    };
    const res = await fetchImpl(OSV_QUERYBATCH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`OSV querybatch ${res.status}`);
    const json = (await res.json()) as { results?: Array<{ vulns?: Array<{ id?: string }> }> };
    const results = json.results ?? [];
    results.forEach((r, j) => {
      const dep = chunk[j];
      for (const v of r.vulns ?? []) {
        if (dep && v.id) matches.push({ dep, id: v.id });
      }
    });
  }
  return matches;
}

/** Enrich each match with severity/summary/fix; a per-id failure → `unknown`. */
async function enrich(
  matches: Array<{ dep: Dep; id: string }>,
  fetchImpl: typeof fetch,
  maxEnrich: number,
  signal?: AbortSignal,
): Promise<DependencyAdvisory[]> {
  const enriched = new Map<string, { severity: AdvisorySeverity; summary: string; fixedIn?: string; url?: string }>();
  const distinctIds = [...new Set(matches.map((m) => m.id))];
  for (const id of distinctIds.slice(0, maxEnrich)) {
    try {
      const res = await fetchImpl(`${OSV_VULN}${encodeURIComponent(id)}`, { signal });
      if (!res.ok) continue;
      const v = (await res.json()) as {
        summary?: string;
        details?: string;
        database_specific?: { severity?: unknown };
        severity?: Array<{ type?: string; score?: string }>;
        affected?: Array<{ ranges?: Array<{ events?: Array<{ fixed?: string }> }> }>;
        references?: Array<{ type?: string; url?: string }>;
      };
      const fixedIn = v.affected
        ?.flatMap((a) => a.ranges ?? [])
        .flatMap((r) => r.events ?? [])
        .map((e) => e.fixed)
        .find((f): f is string => typeof f === "string" && f.length > 0);
      const ref =
        v.references?.find((r) => r.type === "ADVISORY" && r.url)?.url ??
        v.references?.find((r) => r.url)?.url;
      enriched.set(id, {
        severity: severityFromVuln(v),
        summary: (v.summary ?? v.details ?? "").split("\n")[0] ?? "",
        fixedIn,
        url: ref,
      });
    } catch {
      // leave unenriched → unknown below
    }
  }

  return matches.map(({ dep, id }) => {
    const e = enriched.get(id);
    return {
      package: dep.name,
      version: dep.version,
      id,
      severity: e?.severity ?? "unknown",
      summary: e?.summary ?? "",
      ...(e?.fixedIn ? { fixedIn: e.fixedIn } : {}),
      ...(e?.url ? { url: e.url } : {}),
    };
  });
}

/** Default resolver: `npm install --package-lock-only --ignore-scripts` in a
 *  throwaway dir. Resolves the tree without fetching tarballs or running code. */
function defaultResolveLockfile(spec: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "pg-deps-"));
  return new Promise<string | null>((resolve) => {
    execFile(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel",
        "error",
        "--prefix",
        dir,
        "--",
        spec,
      ],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal },
      (err) => {
        try {
          if (err) return resolve(null);
          const lf = join(dir, "package-lock.json");
          resolve(existsSync(lf) ? readFileSync(lf, "utf8") : null);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });
}

/**
 * Audit the dependency tree of an npm target against OSV.dev. Returns an
 * advisory result; non-npm targets (and any failure) return `status: "skipped"`.
 */
export async function auditDependencies(
  target: TargetInput,
  opts: AuditDependenciesOptions = {},
): Promise<DependencyAudit> {
  const now = opts.now ?? (() => new Date().toISOString());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxDeps = opts.maxDeps ?? DEFAULT_MAX_DEPS;
  const maxEnrich = opts.maxEnrich ?? DEFAULT_MAX_ENRICH;

  // ── Applicability: npm refs only ──
  if (typeof target !== "string") {
    return skipped("dependency audit applies to npm targets only (local command)", now);
  }
  if (/^https?:\/\//i.test(target)) {
    return skipped("dependency audit applies to npm targets only (remote https)", now);
  }
  let spec: string;
  try {
    const parsed = parseServerRef(target);
    if (parsed.registry !== "npm") {
      return skipped(`dependency audit not applicable for ${parsed.registry} targets`, now);
    }
    spec = (parsed.owner ? `${parsed.owner}/` : "") + parsed.name + (parsed.version ? `@${parsed.version}` : "");
  } catch {
    return skipped("dependency audit applies to npm targets only", now);
  }

  // ── Resolve the dependency tree ──
  let lockfile: string | null;
  try {
    if (opts.existingLockfile) {
      lockfile = opts.existingLockfile.trimStart().startsWith("{")
        ? opts.existingLockfile
        : existsSync(opts.existingLockfile)
          ? readFileSync(opts.existingLockfile, "utf8")
          : null;
    } else {
      const resolve = opts.resolveLockfile ?? ((s: string) => defaultResolveLockfile(s, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal));
      lockfile = await resolve(spec);
    }
  } catch {
    lockfile = null;
  }
  if (!lockfile) {
    return skipped(`could not resolve a dependency tree for ${spec}`, now);
  }

  const deps = parseLockfile(lockfile).slice(0, maxDeps);

  // ── Query + enrich ──
  let matches: Array<{ dep: Dep; id: string }>;
  try {
    matches = await queryOsv(deps, fetchImpl, opts.signal);
  } catch {
    return skipped("vulnerability database unreachable (offline?)", now);
  }

  const advisories = (await enrich(matches, fetchImpl, maxEnrich, opts.signal)).sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );

  return {
    status: "ok",
    source: "osv.dev",
    ecosystem: "npm",
    queriedAt: now(),
    dependencyCount: deps.length,
    vulnerableCount: new Set(advisories.map((a) => a.package)).size,
    advisories,
  };
}
