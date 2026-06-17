# litmus

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
