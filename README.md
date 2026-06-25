<img src="https://www.polygraph.so/brand/mark.png" alt="polygraph" height="56" />

# litmus

**The open behavioral litmus harness for MCP servers — grade A–F, reproducible.**

[![npm](https://img.shields.io/npm/v/@polygraphso/litmus?style=flat-square&labelColor=0d1117&color=6f42c1)](https://www.npmjs.com/package/@polygraphso/litmus) [![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Polygraph_MCP_gate-6f42c1?style=flat-square&labelColor=0d1117&logo=github&logoColor=white)](https://github.com/marketplace/actions/polygraph-mcp-gate) [![license](https://img.shields.io/badge/license-Apache--2.0-555?style=flat-square&labelColor=0d1117)](LICENSE) [![Glama](https://glama.ai/mcp/servers/polygraphso/litmus/badges/score.svg)](https://glama.ai/mcp/servers/polygraphso/litmus) [![graded by polygraph](https://polygraph.so/api/badge?server=npm/@polygraphso/litmus)](https://polygraph.so/mcp/npm/@polygraphso/litmus)

## Gate your CI on MCP grades — GitHub Action

Fail a build when an MCP **server** or an Agent **Skill** it ships grades **D/F** under the open
behavioral litmus. For servers it is hybrid — a fast lookup of the published grade, then the harness
when ungraded; for skills it is a fast static scan. Un-gradeable targets warn unless `strict`.

```yaml
# .github/workflows/mcp-gate.yml
name: mcp-gate
on: [pull_request]
permissions:
  contents: read
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: polygraphso/litmus@v1
        with:
          # Auto-discovers MCP servers (.mcp.json / .vscode/mcp.json / .cursor/mcp.json)
          # and skills (SKILL.md dirs). Or name them explicitly:
          servers: |
            npm/@modelcontextprotocol/server-filesystem
          skills: |
            ./my-skill
          # min-grade: B      # stricter than the default D/F gate
          # strict: "true"    # also fail on targets that cannot be graded
```

**Inputs:** `servers` · `skills` · `discover` (default `true`) · `min-grade` · `strict` · `working-directory` · `version` · `bearer`. **Outputs:** `result` · `failed` · `report`.

Not on GitHub? The gate is a plain command — `npx @polygraphso/litmus ci` — so it runs in any CI or
as a pre-commit hook. A grade is a measurement, not a guarantee: re-run the open harness to reproduce
any result.

## What litmus is

This is the source for **[`@polygraphso/litmus`](https://www.npmjs.com/package/@polygraphso/litmus)**,
the open behavioral litmus harness for MCP servers from [polygraph.so](https://polygraph.so).

The harness connects to an MCP server the way an agent would, fingerprints its exact
tool surface, and runs four probe categories — **C-01** tool-output injection (static,
dynamic, and second-order — one tool's output weaponized as another's input), **C-02**
permission/egress (in a hardened default-deny Docker sandbox, matched host **and** port),
**C-03** sensitive-data handling (planted canaries), **C-04** adversarial-input handling
(malformed/oversized and jailbreak inputs) — then grades the server **A–F**. A passing grade is a
measurement, not a guarantee; the methodology and its disclosed limits are at
[polygraph.so](https://polygraph.so) (the open source here is the ground truth).

Alongside the grade, an npm target's dependency tree is checked against the
[osv.dev](https://osv.dev) vulnerability database and any vulnerable dependencies are reported as
**dependency advisories**. This is a separate, **point-in-time** signal — it is *advisory only*: it
never affects the A–F grade and is not part of the reproducible evidence (vulnerability data changes
over time, so folding it into the grade would break re-run reproducibility). It applies to npm
targets only; other target kinds report it as skipped. Resolution runs
`npm install --package-lock-only --ignore-scripts`, which resolves the tree without downloading
tarballs or running any package code. Opt out with `--no-deps-audit` (or `LITMUS_DEPS_AUDIT=0`).

The same package also grades **Claude Code / Agent Skills** (a `SKILL.md` + bundle) under a
**separate** static litmus (`litmus-skill-v1`): a deterministic byte-scan — **S-01** prompt
injection, **S-03** data-exfiltration instructions, **S-04** dangerous commands in bundled
scripts — graded **A/B/D/F** and anchored by a whole-directory **content hash**, plus a separate
advisory quality signal. It is *static* (no execution): an **A** is static-clean, not behavioral
proof. See [`packages/litmus/README.md`](packages/litmus/README.md#grade-a-skill).

The hosted, operator-run grading **service** is **not** in this repo — it lives in a
separate private repo and consumes this package from npm like any other client.

## Layout

This is a pnpm monorepo. Only **`@polygraphso/litmus`** is published; the
`@polygraph/*` packages are private building blocks that tsup bundles into it.

```
packages/
  litmus/          # @polygraphso/litmus — the only published package (lib + 3 bins: CLI, skill CLI, MCP)
  core/            # contract types, canonical JSON, identity helpers
  probes/          # the harness: connect, fingerprint, grade, probe runners, sandbox
  onchain/         # EAS attestation read + encode/decode (Base) — read-only, no minting
  agent/           # agent-gate decision logic + live-fingerprint recheck
  mcp/             # MCP server wrapper
  cli/             # CLI commands + target/auth resolution
  demo-*-mcp/      # demo MCP servers used as test fixtures
```

See [`packages/litmus/README.md`](packages/litmus/README.md) for the npm-facing usage docs,
and [polygraph.so](https://polygraph.so) for the methodology and proof format.

## Develop

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm --filter @polygraphso/litmus build   # → packages/litmus/dist
```

## Release

`@polygraphso/litmus` is versioned in `packages/litmus/package.json`. Tag to publish:

```bash
git tag litmus-v<x.y.z> && git push origin litmus-v<x.y.z>
```

The `Publish @polygraphso/litmus` workflow builds, typechecks, tests, and publishes with
npm provenance. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full process and the
local-development workflow for downstream consumers.

## License

[Apache-2.0](LICENSE) — © polygraph.so.
