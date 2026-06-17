<!--
Thanks for contributing to litmus. This repo is public-by-design: assume everything you
commit — code, tests, fixtures, comments, commit messages — is world-readable. See
CONTRIBUTING.md for the full workflow.
-->

## What & why

<!-- What does this change do, and why? Link any related issue, e.g. "Closes #12". -->

## Checklist

- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm -r test` passes
- [ ] `pnpm --filter @polygraphso/litmus build` succeeds
- [ ] `gitleaks detect --no-banner` is clean
- [ ] No secrets, credentials, internal hostnames, or customer data — `.env.example` carries config *shape* only
- [ ] Public API surface (`parseAuthFlags`, `resolveTarget`, `runLitmus`, `EvidenceBundle`) is unchanged — or the change is intentional, called out below, and the version is bumped per semver in `packages/litmus/package.json`
- [ ] Methodology contract is unchanged — probe IDs (server C-01..C-04; skill S-01/S-03/S-04), grading rubric, EAS schemas (server + the separate `LITMUS_SKILL_SCHEMA`), evidence-bundle shape, and `methodologyVersion` (`litmus-v5` / `litmus-skill-v1`) — or the change is deliberate and called out below

## Notes for the reviewer

<!-- Anything that helps review: trade-offs, follow-ups, what you tested, sample CLI output. -->
