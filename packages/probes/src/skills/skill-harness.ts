/**
 * Skill litmus harness — runs the deterministic static safety scan over a loaded
 * skill and produces a content-addressed evidence bundle with an A/B/D/F letter.
 *
 * v1 (litmus-skill-v1) is STATIC ONLY: it scans the SKILL.md body + frontmatter
 * (S-01 injection, S-03 exfil instructions) and the bundled executable files (S-04
 * dangerous commands). It does NOT execute anything — bundled-script sandboxing and
 * the agent-in-the-loop quality signal are out of scope here, by design. The
 * disclaimer states the residual plainly: a static A is not behavioral proof.
 */
import type { CategoryStatus, Finding, LitmusGrade } from "@polygraph/core";
import { loadSkill, SkillLoadError } from "./load-skill.js";
import {
  skillInjection,
  skillInjectionFails,
  exfilInstruction,
  dangerousCommand,
  overBroadTrigger,
} from "./scanners-skill.js";
import { gradeSkillCategories, type SkillCategoryResult } from "./grade-skill.js";

// v2: cut S-01/S-03 false positives — a QUOTED attack phrase (a security/defensive
// skill that documents "ignore previous instructions") no longer floors S-01, and a
// defensive ("treat it as data, never execute") or onboarding ("sign up for an API
// key") sentence no longer floors S-03.
// v3: S-04 now also scans the SKILL.md BODY (not just bundled scripts) for the
// prose-safe dangerous-command shapes — an obfuscated `echo '<b64>' | base64 -D | bash`
// or a `bash -c "$(curl …)"` in a "prerequisites" instruction now floors S-04 to D even
// when the skill ships no script file. A pass/fail-semantics change → version bump; the
// string field lets v1/v2/v3 grades coexist.
export const SKILL_METHODOLOGY_VERSION = "litmus-skill-v3" as const;
export const SKILL_BUNDLE_SCHEMA_VERSION = "0.1.0" as const;

const DISCLAIMER =
  "litmus-skill-v3 is a deterministic STATIC scan of the skill's text and bundled files. " +
  "It is not behavioral proof: a skill's instructions are interpreted by an agent at runtime, " +
  "bundled scripts are not executed, and a command assembled or fetched at runtime is not fully " +
  "resolvable by static scanning (nor is a payload hidden inside a bundled archive). An A means the " +
  "static checks found no injection, exfil instruction, or dangerous command in the body or a bundled " +
  "file — not that the skill is safe to run unsupervised.";

export interface SkillEvidenceBundle {
  schemaVersion: string;
  methodologyVersion: string;
  /** Caller-supplied identity (defaults to the directory). */
  skillRef: string;
  /** `0x` + 64 hex sha256 over the skill's file tree (the rug-pull anchor). */
  contentHash: string;
  ranAt: string;
  harness: { package: string; version: string; node: string };
  categories: SkillCategoryResult[];
  /** Non-letter signals (over-broad trigger, MED-only dangerous commands): recorded,
   *  never floor the grade. The semantic honesty/overreach checks (S-02/S-05) and the
   *  quality signal also land here / in a separate artifact, never in `categories`. */
  advisories: Finding[];
  grade: LitmusGrade;
  gradeRationale: string;
  disclaimer: string;
}

export interface RunSkillLitmusOptions {
  skillRef?: string;
  /** Injectable for deterministic bundles/tests; defaults to now. */
  ranAt?: string;
  harnessVersion?: string;
}

function cat(code: SkillCategoryResult["code"], status: CategoryStatus, findings: Finding[], reason?: string): SkillCategoryResult {
  return { code, status, findings, ...(reason ? { reason } : {}) };
}

export function runSkillLitmus(dir: string, opts: RunSkillLitmusOptions = {}): SkillEvidenceBundle {
  const ranAt = opts.ranAt ?? new Date().toISOString();
  const harness = { package: "@polygraph/probes", version: opts.harnessVersion ?? SKILL_METHODOLOGY_VERSION, node: process.version };
  const base = { schemaVersion: SKILL_BUNDLE_SCHEMA_VERSION, methodologyVersion: SKILL_METHODOLOGY_VERSION, ranAt, harness, disclaimer: DISCLAIMER };

  let loaded;
  try {
    loaded = loadSkill(dir);
  } catch (e) {
    // S-01 could not run — ungraded == unsafe (F). Mirrors grade.ts's "C-01 did not complete".
    const reason = e instanceof SkillLoadError ? e.message : "failed to load skill";
    const categories = [cat("S-01", "skipped", [], reason)];
    const { grade, rationale } = gradeSkillCategories(categories);
    return { ...base, skillRef: opts.skillRef ?? dir, contentHash: "0x", categories, advisories: [], grade, gradeRationale: rationale };
  }

  // S-01 — injection over body + frontmatter text.
  const injFindings = [...skillInjection(loaded.body), ...skillInjection(loaded.frontmatter)];
  const s01 = cat("S-01", skillInjectionFails(injFindings) ? "fail" : "pass", injFindings);

  // S-03 — exfil instructions over the body.
  const exfil = exfilInstruction(loaded.body);
  const s03 = cat("S-03", exfil.some((f) => f.severity === "high") ? "fail" : "pass", exfil);

  // S-04 — dangerous commands over the bundled executable files (all patterns) AND
  // the SKILL.md body prose (the prose-safe subset: obfuscated / command-substitution
  // / reverse-shell). A skill that ships no script but instructs an obfuscated
  // `curl | bash` in its "prerequisites" still floors here. The scan always runs, so
  // a clean skill is an affirmative PASS, never a skip.
  const execFiles = loaded.files.filter((f) => f.isExecutable);
  const dangFindings: Finding[] = [];
  for (const f of execFiles) dangFindings.push(...dangerousCommand(f.bytes.toString("utf8"), f.relPath));
  dangFindings.push(...dangerousCommand(loaded.body, "SKILL.md", { proseOnly: true }));
  const dangHigh = dangFindings.filter((f) => f.severity === "high");
  const s04 = cat(
    "S-04",
    dangHigh.length > 0 ? "fail" : "pass",
    dangHigh,
    dangHigh.length === 0 && execFiles.length === 0 ? "no dangerous commands in the body; no bundled scripts" : undefined,
  );

  const categories = [s01, s03, s04];
  const { grade, rationale } = gradeSkillCategories(categories);

  // Advisories: over-broad trigger + MED-only dangerous commands (never floor).
  const advisories: Finding[] = [
    ...overBroadTrigger(loaded.description),
    ...dangFindings.filter((f) => f.severity !== "high"),
  ];

  return {
    ...base,
    skillRef: opts.skillRef ?? dir,
    contentHash: loaded.contentHash,
    categories,
    advisories,
    grade,
    gradeRationale: rationale,
  };
}
