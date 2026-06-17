/**
 * Skill QUALITY signal — "is this skill well-formed / does it work" — kept STRICTLY
 * separate from the deterministic A/B/D/F safety letter. This is a wholly separate
 * artifact (QualityBundle) that REFERENCES a skill by skillRef + contentHash but is
 * never embedded in, hashed into, or minted alongside the safety EvidenceBundle.
 * Its verdict vocabulary is deliberately NOT a letter, so it can never be mistaken
 * for — or laundered into — the safety grade.
 *
 * v1 runs only the DETERMINISTIC well-formedness axis (frontmatter lint + bundled-
 * resource resolution): bit-stable, no LLM, safe for the open repo. The non-
 * deterministic, LLM-judged axes (outcome fidelity, trigger calibration) are added
 * later and — because they need a paid judge model — likely run in the operator
 * service, not here. Until then this bundle states plainly that it is advisory and
 * which axes have not run.
 */
import { loadSkill, SkillLoadError } from "./load-skill.js";

export const SKILL_QUALITY_VERSION = "skill-quality-v1" as const;

const QUALITY_DISCLAIMER =
  "skill-quality-v1 is an ADVISORY signal, separate from the safety grade. It is never an A–F " +
  "letter and is never minted on-chain. This version runs only the deterministic well-formedness " +
  "checks; the non-deterministic, LLM-judged axes (outcome fidelity, trigger calibration) are not " +
  "included, so it does not assert that the skill actually works.";

export type QualityCheckStatus = "pass" | "warn" | "fail";
/** Deliberately not A–F: a quality verdict must never read as a safety letter. */
export type QualityVerdict = "well-formed" | "issues" | "malformed";

export interface QualityCheck {
  id: string;
  status: QualityCheckStatus;
  detail: string;
}

export interface QualityBundle {
  qualityVersion: string;
  /** Binds to the exact skill it evaluated; the SAME identity as the safety bundle… */
  skillRef: string;
  /** …but carried in a SEPARATE artifact — never inside the safety EvidenceBundle. */
  contentHash: string;
  ranAt: string;
  verdict: QualityVerdict;
  checks: QualityCheck[];
  disclaimer: string;
}

export interface RunSkillQualityOptions {
  skillRef?: string;
  ranAt?: string;
}

/** Relative markdown links/images in the body that point into the bundle. */
function brokenBundleLinks(body: string, relPaths: ReadonlySet<string>): string[] {
  const broken: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)) {
    let ref = m[1]!.trim();
    if (/^(?:https?:|mailto:|tel:|data:|#)/i.test(ref) || ref.startsWith("/")) continue;
    ref = ref.replace(/^\.\//, "").split("#")[0]!.split("?")[0]!.normalize("NFC");
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    if (!relPaths.has(ref)) broken.push(ref);
  }
  return broken;
}

export function runSkillQuality(dir: string, opts: RunSkillQualityOptions = {}): QualityBundle {
  const ranAt = opts.ranAt ?? new Date().toISOString();
  const base = { qualityVersion: SKILL_QUALITY_VERSION, ranAt, disclaimer: QUALITY_DISCLAIMER };

  let loaded;
  try {
    loaded = loadSkill(dir);
  } catch (e) {
    return {
      ...base,
      skillRef: opts.skillRef ?? dir,
      contentHash: "0x",
      verdict: "malformed",
      checks: [{ id: "loadable", status: "fail", detail: e instanceof SkillLoadError ? e.message : "could not load skill" }],
    };
  }

  const checks: QualityCheck[] = [];
  const name = /(^|\n)name\s*:/i.test(loaded.frontmatter);
  checks.push(
    name
      ? { id: "frontmatter-name", status: "pass", detail: "frontmatter has a name" }
      : { id: "frontmatter-name", status: "fail", detail: "frontmatter is missing `name`" },
  );
  checks.push(
    loaded.description.trim()
      ? { id: "frontmatter-description", status: "pass", detail: "frontmatter has a non-empty description" }
      : { id: "frontmatter-description", status: "fail", detail: "frontmatter is missing a non-empty `description` (the skill's activation trigger)" },
  );
  checks.push(
    loaded.body.trim()
      ? { id: "body-nonempty", status: "pass", detail: "the instruction body is non-empty" }
      : { id: "body-nonempty", status: "fail", detail: "the instruction body is empty" },
  );

  const relPaths = new Set(loaded.files.map((f) => f.relPath));
  const broken = brokenBundleLinks(loaded.body, relPaths);
  checks.push(
    broken.length === 0
      ? { id: "bundled-links-resolve", status: "pass", detail: "all relative links in the body resolve to bundled files" }
      : { id: "bundled-links-resolve", status: "warn", detail: `broken relative link(s) to: ${broken.slice(0, 5).join(", ")}` },
  );

  const verdict: QualityVerdict = checks.some((c) => c.status === "fail")
    ? "malformed"
    : checks.some((c) => c.status === "warn")
      ? "issues"
      : "well-formed";

  return { ...base, skillRef: opts.skillRef ?? dir, contentHash: loaded.contentHash, verdict, checks };
}
