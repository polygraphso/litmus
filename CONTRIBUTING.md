# Contributing to litmus

## This repository is public

**Assume everything you commit here — code, tests, fixtures, comments, and commit messages —
is world-readable.** Do not paste
tokens, API keys, private keys, RPC URLs with embedded credentials, customer server names,
or internal infrastructure details anywhere. Configuration *shape* goes in `.env.example`
with placeholder values only; real values stay in your gitignored `.env`.

A `secret-scan` workflow (gitleaks) runs on every push and pull request and will fail the
build on findings. Run it locally before pushing:

```bash
gitleaks detect --no-banner
```

## Development

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm --filter @polygraphso/litmus build
```

Only `@polygraphso/litmus` is published; the `@polygraph/*` packages are private building
blocks bundled into it by tsup. Anchor changes against the methodology at
[polygraph.so](https://polygraph.so); the open source here is the ground truth.

## Releasing

`@polygraphso/litmus` is versioned in `packages/litmus/package.json`. The full flow (must be
in this order — tagging a feature branch orphans the tag):

1. **Land all changes on `main` first** via squash-merged PRs. Feature PRs do not bump the
   version.
2. **Open a version bump PR.** Edit `version` in `packages/litmus/package.json` **and both
   `version` fields in `server.json`** (directory registries like Glama read `server.json` to
   pick which npm version to install — a stale value installs the wrong release). The runner's
   consumed surface — `parseAuthFlags`, `resolveTarget`, `runLitmus`, `EvidenceBundle`, and the
   skill surface (`runSkillLitmus`, `runSkillQuality`/`runSkillQualityJudged`,
   `SkillEvidenceBundle`, `handleRunSkillLitmus`/`handleVerifySkill`) — is a public API
   contract; treat changes to it as semver-significant. Squash-merge the bump PR to `main`.
3. **Tag the merged commit on `main`:**
   `git tag litmus-v<x.y.z> <main-sha> && git push origin litmus-v<x.y.z>`
   The push triggers `.github/workflows/publish.yml` (typecheck → test → build → npm publish
   with provenance).
4. **Retag `v1`** to the same commit so the CI-gate action (`uses: polygraphso/litmus@v1`)
   runs the current release:
   `git tag -f v1 <main-sha> && git push origin v1 --force`
5. **Bump the action pin** in `action.yml` (`inputs.version.default`) to the new version string,
   and open + merge a PR for that change.
6. **Create the GitHub Release:**
   `gh release create litmus-v<x.y.z> --title "@polygraphso/litmus <x.y.z>" --notes "<one-paragraph changelog>"`
   The publish workflow does not create releases automatically.

## Working on the harness against a downstream consumer

If you're iterating on the harness while testing it from the hosted service (or any consumer)
in a side-by-side checkout, point the consumer at your local build with a **local-only,
uncommitted** pnpm override in the *consumer's* `package.json`:

```jsonc
{
  "pnpm": {
    "overrides": {
      "@polygraphso/litmus": "link:../litmus/packages/litmus"
    }
  }
}
```

Then rebuild the package after each change (the consumer imports the built `dist/`, and the
build's `onSuccess` keeps `dist/docker` correct):

```bash
pnpm --filter @polygraphso/litmus build   # or: tsup --watch, from packages/litmus
```

Never commit that override — CI and production must always resolve the real published version.
Avoid `file:` (copies, goes stale) and global `pnpm link` (stateful, easy to forget to unlink).
