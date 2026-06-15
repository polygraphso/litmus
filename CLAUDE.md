# litmus — workspace context for Claude

This repo **is the open `@polygraphso/litmus` harness** — the behavioral litmus test for
MCP servers, its onchain proof (EAS attestation on Base), and the agent-gate. It is the
*engine*; the hosted, operator-run grading **service** that runs it lives in a **separate**
repo (`the hosted service`) and is **not here**.

> **This repository is public-by-design.** It is private today but built to be opened, and
> every commit, file, and history entry is or will be world-readable. **Never add secrets,
> credentials, internal hostnames, customer data, ops/infra config, the runner, or `.env`
> files.** `.env.example` carries config *shape* only. Openness is the point: the grade is
> reproducible precisely because the harness is public, so anyone can re-run it and disprove
> a false grade.

## Where to look first

- `README.md` — what this repo is, the layout, build/test/release.
- `docs/` — **the settled spec.** `docs/how-it-works.md` (overview), `docs/litmus-test-v1.md`
  (methodology), `docs/onchain-proof-spec.md` (proof format + trust model),
  `docs/technical-design.md` (package layout). `docs/` is the source of truth — anchor against
  it, don't relitigate it.
- `packages/litmus/README.md` — the npm-facing usage docs.

## What we're building (one paragraph)

A harness connects to an MCP server like an agent would — stdio for local packages, Streamable
HTTP for remote URLs — fingerprints the exact tool surface (`tools/list` → canonical JSON →
sha256 → `bytes32`), then runs three probe categories: **C-01** tool-output injection, **C-02**
permission overreach (egress, in a hardened default-deny Docker sandbox with a sinkhole),
**C-03** sensitive-data handling (planted canaries). It grades **A–F**, pins a deterministic
evidence bundle to IPFS, and signs an **EAS attestation on Base** carrying the grade, the
fingerprint, and the report CID. The grade is **reproducible** — the harness is open and
deterministic, so anyone can re-run it against the same server and disprove a false grade.

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

## How to help

- **Anchor on the docs.** The methodology (`litmus-v2`; the spec file keeps its `litmus-test-v1.md`
  name for link stability), probe IDs, the EAS schema, and the evidence-bundle shape are locked
  there. Reuse them; don't reinvent or drift. Keep the `methodologyVersion` field stable across
  refactors — it's a data contract with the DB/onchain proof.
- **Keep the honesty.** The v1 trade-offs are disclosed, not hidden: self-mint is forgeable,
  mitigated by **reproducibility** (the open harness makes a false grade falsifiable), and the
  live-fingerprint recheck gives rug-pull resistance. Evasion (a server that detects the test
  context) is the residual limit. Unforgeable/independent upgrades (staked bond, zkTLS, TEE,
  independent re-run) are roadmap, not v1. Don't paper over these or claim more than
  reproducibility buys.
- **Tone:** serious, calm, expert, plain English — "scientific preprint," never web3-bro /
  VC-bro / "revolutionize" / generic "AI safety" language.

## What not to do

- Don't add the hosted service, infra, secrets, or the runner here — they belong in `the hosted service`.
- Don't add features, abstractions, or backwards-compat shims beyond what a task requires.
- Don't claim work runs or passes without verifying it — evidence before assertions.
