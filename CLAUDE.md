# litmus — workspace context for Claude

This repo **is the open `@polygraphso/litmus` harness** — the behavioral litmus test for
MCP servers, its onchain proof (EAS attestation on Base), and the agent-gate. It is the
*engine*; the hosted, operator-run grading **service** that runs it lives in a **separate
private repo** and is **not here**.

> **This repository is public.** Every commit, file, and history entry is world-readable.
> **Never add secrets, credentials, internal hostnames, customer data, ops/infra config, the
> runner, or `.env` files.** `.env.example` carries config *shape* only. Openness is the point:
> the grade is reproducible precisely because the harness is public, so anyone can re-run it and
> disprove a false grade.

## Where to look first

- `README.md` — what this repo is, the layout, build/test/release.
- `packages/litmus/README.md` — the npm-facing usage docs.
- **The methodology + proof spec live at [polygraph.so](https://polygraph.so)** (the prose docs
  are not kept in this repo). The open source here — `packages/probes` (the probes/grading) and
  `packages/onchain` (the EAS schema/encode) — is the source of truth; anchor against the code
  and the published methodology, don't relitigate them.

## What we're building (one paragraph)

A harness connects to an MCP server like an agent would — stdio for local packages, Streamable
HTTP for remote URLs — fingerprints the exact tool surface (`tools/list` → canonical JSON →
sha256 → `bytes32`), then runs four probe categories: **C-01** tool-output injection, **C-02**
permission overreach (egress, in a hardened default-deny Docker sandbox with a sinkhole),
**C-03** sensitive-data handling (planted canaries), **C-04** adversarial-input handling
(malformed/oversized + jailbreak inputs; fails on crash, internals-leak, or amplification →
caps at D). It grades **A–F** and produces a
deterministic, content-addressed evidence bundle. This package **grades and verifies only** —
it does **not** mint (no pin-to-IPFS, no EAS write, no `/mint` hand-off). `packages/onchain`
keeps the EAS **read**/encode/decode + the agent-gate, so an agent can still verify a published
attestation; producing one is out of scope. The grade is **reproducible** — the harness is open
and deterministic, so anyone can re-run it against the same server and disprove a false grade.

## Packaging model (do not break)

- **Only `@polygraphso/litmus` (`packages/litmus`) is published.** The six `@polygraph/*`
  building blocks (`core, probes, onchain, agent, mcp, cli`) stay `private: true` workspace
  packages; tsup **bundles** them into litmus's `dist/` via `noExternal: [/^@polygraph\//]`,
  so the published manifest has zero `workspace:*` deps.
- The `parseAuthFlags`/`resolveTarget`/`runLitmus`/`EvidenceBundle` surface re-exported from
  `packages/litmus/src/index.ts` is a **public API contract** consumed by the hosted runner.
  Treat changes to it as semver-significant.
- The egress-sandbox Docker assets live in `packages/probes/docker/` and are copied to
  `dist/docker` by tsup's `onSuccess`; the harness self-locates them via `import.meta.url`.

## Releasing

Only `@polygraphso/litmus` is published, and a release is driven by a **git tag**. `main` is
protected — every change lands via PR — so the steps are ordered and can't be skipped or
reordered:

1. **Land the work on `main` first.** Feature/fix PRs squash-merge to `main`; they do **not** bump
   the version.
2. **Bump the version in its own PR.** Edit `version` in `packages/litmus/package.json` (semver:
   patch for fixes, minor for backward-compatible features, pre-1.0) **and the two `version`
   fields in `server.json`** (the MCP-registry manifest — directories like Glama read it to pick
   the npm version to install, so a stale value installs an old release). Title it
   `chore(release): @polygraphso/litmus <x.y.z>`, and squash-merge it. The publish workflow ships
   whatever version is in `package.json`, so the bump must be on `main` **before** the tag. A
   version-only change doesn't touch `pnpm-lock.yaml`, so the workflow's `--frozen-lockfile`
   install stays green.
3. **Tag the merged commit on `main`** (not the feature branch — tagging a branch orphans the
   tag): `git tag litmus-v<x.y.z> <main-sha> && git push origin litmus-v<x.y.z>`. The tag prefix is
   `litmus-v` (package-scoped). The push triggers `.github/workflows/publish.yml` (typecheck →
   test → build → `npm publish` with provenance).
4. **Create the GitHub Release.** The workflow publishes to npm but does **not** create a GitHub
   Release — do it explicitly: `gh release create litmus-v<x.y.z> --title "@polygraphso/litmus
   <x.y.z>" --notes "<one-paragraph changelog>"`, with notes pointing at the PRs the release ships.

So one tag yields two artifacts: the **npm publish** (automated by the workflow) and the **GitHub
Release** (manual `gh release create`). Never squash-merge a release PR or push a release tag
without an explicit go-ahead.

## How to help

- **Anchor on the methodology** (`litmus-v10`), published at [polygraph.so](https://polygraph.so);
  the probe IDs, the EAS schema, and the evidence-bundle shape are fixed by the code here. Reuse
  them; don't reinvent or drift. The `methodologyVersion` field is a data contract with the
  DB/onchain proof — bump it only on a genuine pass/fail-semantics change (v4 added C-04), and
  keep it a string so older attestations coexist. C-04 is graded **off-chain**: it moves the
  overall letter grade but the EAS schema keeps three per-category `uint8` slots (`packages/onchain/src/eas.ts`).
- **Keep the honesty.** The v1 trade-offs are disclosed, not hidden: self-mint is forgeable,
  mitigated by **reproducibility** (the open harness makes a false grade falsifiable), and the
  live-fingerprint recheck gives rug-pull resistance. Evasion (a server that detects the test
  context) is the residual limit. Unforgeable/independent upgrades (staked bond, zkTLS, TEE,
  independent re-run) are roadmap, not v1. Don't paper over these or claim more than
  reproducibility buys.
- **Tone:** serious, calm, expert, plain English — "scientific preprint," never web3-bro /
  VC-bro / "revolutionize" / generic "AI safety" language.

## What not to do

- Don't add the hosted service, infra, secrets, or the runner here — they belong with the hosted service, not in this repo.
- Don't add features, abstractions, or backwards-compat shims beyond what a task requires.
- Don't claim work runs or passes without verifying it — evidence before assertions.
