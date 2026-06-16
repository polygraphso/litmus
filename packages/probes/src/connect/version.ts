/**
 * Version resolution for an isolated (Docker) npm grade.
 *
 * The version we RECORD is the one the offline resolver read from the installed
 * `package.json` (`staged`) — never the requested pin (`requested`), which is an
 * unverified spec until install. A *concrete* pin (`1.2.3`) that disagrees with
 * what npm actually installed fails closed: a published grade must not mislabel
 * the version it was run against. A range or dist-tag pin (`latest`, `1`, `1.2`)
 * legitimately resolves to a concrete version, so it is never a mismatch.
 */

/** A concrete version literal is `major.minor.patch` (optionally with a
 *  prerelease/build suffix). Dist-tags (`latest`) and partials (`1`, `1.2`) are
 *  not concrete — they resolve to a concrete version at install time. */
export function isConcreteVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+/.test(v);
}

export function resolveStagedVersion(
  requested: string | null,
  staged: string | null,
): string | null {
  if (
    requested !== null &&
    staged !== null &&
    isConcreteVersion(requested) &&
    staged !== requested
  ) {
    throw new Error(
      `requested version ${requested} but the staged package resolved to ${staged}`,
    );
  }
  return staged;
}
