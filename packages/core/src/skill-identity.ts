/**
 * Skill-identity helpers for refs of the form `{source}/{owner}/{name}[#{path}][@{ref}]`.
 *
 * Deliberately a SEPARATE namespace from the server `Registry` (identity.ts): a
 * skill grade must never be readable as a server grade, so `SkillSource` and
 * `Registry` do not overlap and the skill attestation uses its own EAS schema UID.
 *
 * A skill is static content, so the trust anchor is a CONTENT HASH of the whole
 * directory (load-skill.ts), and the `@{ref}` pin should be IMMUTABLE (a git commit
 * sha or the contentHash itself), never a mutable tag — there is no live re-
 * fingerprint to catch drift, so the pin is all that binds a grade to the bytes.
 *
 * Examples:
 *   github/anthropic/skills#document-skills/pdf@a1b2c3d   (repo + subdir + commit)
 *   marketplace/acme/format-markdown                      (a marketplace coordinate)
 *   npm/@acme/skills#skills/tidy@1.4.0                     (a skill shipped in a pkg)
 */

export type SkillSource = "github" | "marketplace" | "npm";

export interface ParsedSkillRef {
  source: SkillSource;
  /** Null for sources that don't namespace by owner (rare); usually present. */
  owner: string | null;
  name: string;
  /** Subdirectory of the skill within the source (the SKILL.md folder), or null. */
  path: string | null;
  /** Immutable content pin (commit sha / contentHash). Mutable tags are discouraged. */
  ref: string | null;
}

const SOURCES = new Set<SkillSource>(["github", "marketplace", "npm"]);

// Same security discipline as identity.ts: segments may feed clone/install/path
// operations, so each must start alphanumeric and avoid shell/path metacharacters.
// An owner may carry a leading "@" (npm scope); names/refs may not. A path is a
// `/`-separated run of name-shaped segments.
const OWNER_RE = /^@?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const PATH_SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class SkillRefParseError extends Error {
  constructor(ref: string, reason: string) {
    super(`Invalid skill ref "${ref}": ${reason}`);
    this.name = "SkillRefParseError";
  }
}

export function parseSkillRef(ref: string): ParsedSkillRef {
  const firstSlash = ref.indexOf("/");
  if (firstSlash === -1) throw new SkillRefParseError(ref, "expected `{source}/...`");
  const source = ref.slice(0, firstSlash);
  if (!SOURCES.has(source as SkillSource)) {
    throw new SkillRefParseError(ref, `unknown source "${source}" (expected one of: ${[...SOURCES].join(", ")})`);
  }
  let rest = ref.slice(firstSlash + 1);

  // Strip the optional trailing `@ref` pin FIRST (the canonical order is
  // `…#path@ref`, so the last `@` is the pin delimiter; a path segment can't carry
  // `@`). lastIndexOf, but skip a leading npm scope `@` at position 0.
  let pin: string | null = null;
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    pin = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!pin) throw new SkillRefParseError(ref, "empty ref after `@`");
    if (!REF_RE.test(pin)) throw new SkillRefParseError(ref, "ref contains disallowed characters");
  }

  // Then split the optional `#path`.
  let path: string | null = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    path = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
    if (!path) throw new SkillRefParseError(ref, "empty path after `#`");
    for (const seg of path.split("/")) {
      if (!PATH_SEG_RE.test(seg)) throw new SkillRefParseError(ref, "path contains disallowed characters");
    }
  }

  const lastSlash = rest.lastIndexOf("/");
  let owner: string | null;
  let name: string;
  if (lastSlash === -1) {
    owner = null;
    name = rest;
  } else {
    owner = rest.slice(0, lastSlash);
    name = rest.slice(lastSlash + 1);
  }
  if (!name) throw new SkillRefParseError(ref, "empty name segment");
  if (owner !== null && !OWNER_RE.test(owner)) throw new SkillRefParseError(ref, "owner contains disallowed characters");
  if (!NAME_RE.test(name)) throw new SkillRefParseError(ref, "name contains disallowed characters");

  return { source: source as SkillSource, owner, name, path, ref: pin };
}

export function formatSkillRef(p: ParsedSkillRef): string {
  let base = p.owner ? `${p.source}/${p.owner}/${p.name}` : `${p.source}/${p.name}`;
  if (p.path) base += `#${p.path}`;
  return p.ref ? `${base}@${p.ref}` : base;
}

/** Versionless identity of a skill (drops the `@ref` pin, keeps the `#path` — a
 *  repo can hold many skills, so the path is part of the identity). */
export function skillKey(p: Pick<ParsedSkillRef, "source" | "owner" | "name" | "path">): string {
  const base = p.owner ? `${p.source}/${p.owner}/${p.name}` : `${p.source}/${p.name}`;
  return p.path ? `${base}#${p.path}` : base;
}
