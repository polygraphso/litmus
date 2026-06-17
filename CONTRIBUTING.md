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

`@polygraphso/litmus` is versioned in `packages/litmus/package.json`. To publish:

1. Bump the version (semver: additive surface → minor, breaking → major). The runner's
   consumed surface — `parseAuthFlags`, `resolveTarget`, `runLitmus`, `EvidenceBundle`, and
   the skill surface (`runSkillLitmus`, `runSkillQuality`/`runSkillQualityJudged`,
   `SkillEvidenceBundle`, `handleRunSkillLitmus`/`handleVerifySkill`) the hosted runner
   imports — is a public API contract; treat changes to it accordingly.
2. `git tag litmus-v<x.y.z> && git push origin litmus-v<x.y.z>`.
3. The `Publish @polygraphso/litmus` workflow builds, typechecks, tests, and publishes to npm
   with provenance.

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
