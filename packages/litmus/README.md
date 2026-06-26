# @polygraphso/litmus

[![polygraph](https://polygraph.so/api/badge?server=npm/@polygraphso/litmus)](https://polygraph.so/mcp/npm/@polygraphso/litmus)

The behavioral **litmus** harness for MCP servers, from [polygraph.so](https://polygraph.so).

It connects to an MCP server the way an agent would, fingerprints its exact tool
surface, and runs four probe categories — **C-01** tool-output injection (static,
dynamic, and second-order — one tool's output weaponized as another's input),
**C-02** permission/egress (in a hardened default-deny Docker sandbox, matched host
**and** port), **C-03** sensitive-data handling (planted canaries), **C-04**
adversarial-input handling (malformed/oversized and jailbreak inputs) — then grades
the server **A–F** and produces a deterministic, content-addressed evidence bundle.

A passing grade is a measurement, not a guarantee. The methodology and its
disclosed limits live at [polygraph.so](https://polygraph.so).

## Install

```bash
npm i -g @polygraphso/litmus
# …or run without installing (note the -p flag — the package ships two bins,
# `polygraphso-litmus` and `polygraphso-litmus-mcp`, so npx needs to be told which):
npx -y -p @polygraphso/litmus polygraphso-litmus litmus npm/@modelcontextprotocol/server-filesystem
```

Requires Node ≥ 18. **Docker is optional** — without it, C-02 (egress) is skipped
and the grade is capped at **B** for that run.

### Gate your CI (GitHub Action)

Fail a build when an MCP **server** — or an Agent **Skill** it ships — grades **D/F**.
The [**polygraph MCP gate**](https://github.com/marketplace/actions/polygraph-mcp-gate)
on the GitHub Marketplace wraps the harness as `polygraphso/litmus@v1`:

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
      - uses: actions/checkout@v5
      - uses: polygraphso/litmus@v1
        with:
          # Auto-discovers MCP servers (.mcp.json / .vscode/mcp.json / .cursor/mcp.json)
          # and skills (SKILL.md dirs). Or name them explicitly:
          servers: |
            npm/@modelcontextprotocol/server-filesystem
          # min-grade: B      # stricter than the default D/F gate
          # strict: "true"    # also fail on targets that cannot be graded
```

Inputs: `servers` · `skills` · `discover` (default `true`) · `min-grade` · `strict` ·
`working-directory` · `version` · `bearer`. Outputs: `result` · `failed` · `report`.
Not on GitHub? The gate is a plain command —
`npx -y -p @polygraphso/litmus polygraphso-litmus ci` — so it runs in any CI or as a
pre-commit hook.

## CLI

```bash
polygraphso-litmus litmus <registry-ref | https-url | path-to-mcp>   # grade a server
polygraphso-litmus litmus --json <ref>                              # machine-readable evidence bundle
polygraphso-litmus litmus --timeout <seconds> <ref>                 # cap the whole run (default 900s)
polygraphso-litmus litmus --no-deps-audit <ref>                     # skip the dependency advisory scan
polygraphso-litmus check <ref>                                      # look up a published grade
```

Examples:

```bash
# a remote https target runs no local code — graded directly
polygraphso-litmus litmus https://example.com/mcp

# a registry ref or local file launches the TARGET's own code. Grade it sandboxed:
LITMUS_STDIO_ISOLATION=docker polygraphso-litmus litmus npm/@modelcontextprotocol/server-filesystem
# …or, without Docker, opt in to running it on this host:
polygraphso-litmus litmus --unsafe-host-exec npm/@modelcontextprotocol/server-filesystem
```

**Host-execution safety.** Grading a registry ref (`npm/…`, `pypi/…`) or a local
path **launches the target's own code**. By default the CLI refuses to do that on
your host: set `LITMUS_STDIO_ISOLATION=docker` to run the target only inside the
hardened sandbox, or pass `--unsafe-host-exec` to accept host execution. Remote
`https://` targets run no local code and need neither.

**Dependency advisories.** Below the grade, an `npm/…` target's dependency tree is
checked against the [osv.dev](https://osv.dev) vulnerability database and any
vulnerable dependencies are listed. This is **advisory only and point-in-time**: it
never affects the A–F grade and is not part of the evidence bundle (vulnerability
data changes over time, so it stays out of the reproducible verdict). Other target
kinds report it as skipped. The scan resolves the tree with
`npm install --package-lock-only --ignore-scripts` — no tarballs are downloaded and
no package code runs. Opt out with `--no-deps-audit` or `LITMUS_DEPS_AUDIT=0`. From
the `run_litmus` MCP tool it is returned as a separate `dependencyAudit` field.

**Token-gated servers.** If a target is a token-gated `https://` server and you pass no
`--bearer` / `--header` / `LITMUS_BEARER`, litmus — on the auth failure — looks for a token you
already configured for that server (matched by URL in your MCP client config: project
`.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json`, or your Claude Code / Claude Desktop /
Cursor config) and offers to reuse it. It is read-only, asks before sending, sends only to the
target origin, and never prints the token. In non-interactive use, pass `--use-discovered-auth`
to opt in without a prompt.

If the server uses **OAuth** (no static token to reuse), litmus opens your browser to authorize,
captures the token via a single-use `127.0.0.1` callback, and grades with it — used for that run
only, never stored. This happens automatically on an interactive terminal; use `--oauth` /
`--no-oauth` to force or skip it. From the `run_litmus` MCP tool, set `interactive_auth: true`.

The `litmus` command exits non-zero on a failing grade (D/F), so it scripts in CI.

To dispute a published grade, just re-run `litmus` against the same server: the harness is
open and deterministic, so a re-run reproduces the grade — or refutes it.

## Use it from an AI agent (MCP server)

The package ships a stdio MCP server, `polygraphso-litmus-mcp`, so it works in any
MCP-capable client. It exposes two tools:

- **`run_litmus`** — actively grade a server *now* (runs the harness end-to-end)
  and return the grade and the evidence. Optional **`bearer`** (and `header`
  entries, each `"Key: Value"`) grade a token-gated `https://` MCP target — sent
  to that origin only, ignored for stdio/local targets, the same plumbing as the
  CLI's `--bearer` / `--header`. Grading a registry ref or local path launches the
  target's own code, so it requires **`unsafe_host_exec: true`** unless
  `LITMUS_STDIO_ISOLATION=docker` is set (the MCP mirror of `--unsafe-host-exec`).
- **`verify_attestation`** — passively read a server's *already-published* grade
  before trusting or paying it.

It also registers two **prompts** that show up as slash commands — in Claude Code,
`/mcp__polygraph-litmus__grade <server_ref>` (run a fresh grade) and
`/mcp__polygraph-litmus__check <server_ref>` (read a published grade); other
clients surface the same prompts in their own UI. For a cleaner pair of commands
in Claude Code — `/polygraph:grade` and `/polygraph:check` — install the plugin
(below), which wires up this server and both commands in one step.

**Prerequisites:** Node ≥ 18. Docker is optional (without it, C-02 egress is
skipped and the grade caps at B). Set `POLYGRAPH_API_URL=https://polygraph.so` so
`verify_attestation` can look up published grades.

> **Heads-up:** grade *publishing* is still rolling out, so `verify_attestation`
> commonly returns `not_available` today — that means *unevaluated*, not a failing
> grade. To grade a server right now, use `run_litmus`.

### Claude Code: one-click plugin (recommended)

The plugin bundles this MCP server **and** adds the `/polygraph:grade` and
`/polygraph:check` commands — one install does everything:

```
/plugin marketplace add polygraphso/litmus
/plugin install polygraph@polygraphso
```

Then just run `/polygraph:grade npm/@modelcontextprotocol/server-filesystem`.

Prefer to wire the server up by hand, or using another client? Add it once, then
just talk to your agent.

**Claude Code** — one command:

```bash
claude mcp add polygraph-litmus -e POLYGRAPH_API_URL=https://polygraph.so \
  -- npx -y -p @polygraphso/litmus polygraphso-litmus-mcp
```

**Cursor** — one-click install:

[![Add polygraph-litmus to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=polygraph-litmus&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi1wIiwiQHBvbHlncmFwaHNvL2xpdG11cyIsInBvbHlncmFwaHNvLWxpdG11cy1tY3AiXSwiZW52Ijp7IlBPTFlHUkFQSF9BUElfVVJMIjoiaHR0cHM6Ly9wb2x5Z3JhcGguc28ifX0=)

Or wire it up by hand — **Claude Desktop** (`claude_desktop_config.json`) / **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "polygraph-litmus": {
      "command": "npx",
      "args": ["-y", "-p", "@polygraphso/litmus", "polygraphso-litmus-mcp"],
      "env": { "POLYGRAPH_API_URL": "https://polygraph.so" }
    }
  }
}
```

> The `-p` flag is required: this package ships two bins, so plain `npx @polygraphso/litmus` can't tell which to run. If you installed globally (`npm i -g @polygraphso/litmus`) you can instead use `"command": "polygraphso-litmus-mcp"` with no args.

**Any other MCP client / the Claude Agent SDK:** spawn the same stdio command —
`npx -y -p @polygraphso/litmus polygraphso-litmus-mcp`.

### Then just ask your agent

> Run polygraph against `npm/@modelcontextprotocol/server-filesystem` and tell me the grade.

The agent calls **`run_litmus`**, which launches that server in the harness, runs
C-01/C-02/C-03/C-04, and returns the **grade (A–F)**, the per-category results, and the
tool-surface fingerprint. Use **`verify_attestation`** instead to read a grade
that's already published.

`run_litmus` launches the target server's code to exercise it (egress-sandboxed
when Docker is present). It needs no wallet or RPC.

### ChatGPT and other remote clients

ChatGPT's MCP support expects a remote **Streamable-HTTP** server; this package is
**stdio-only**, so you can't point ChatGPT at it directly. If you self-host, bridge
stdio over HTTP yourself — e.g.

```bash
npx -y supergateway --stdio "npx -y -p @polygraphso/litmus polygraphso-litmus-mcp" --port 8000
```

(or [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy)) — then point your client
at that endpoint. polygraph does not host this for you; the bridge runs on your own
machine.

### Troubleshooting

- **Two bins / `npx`:** `npx` needs `-p @polygraphso/litmus` *plus* the bin name
  (`polygraphso-litmus` or `polygraphso-litmus-mcp`); plain `npx @polygraphso/litmus`
  can't choose which to run. Installed globally? Use the bin name directly, no `-p`.
- **Docker optional:** without Docker, C-02 (egress) is skipped and the grade caps
  at **B** — the C-02 row reads `skipped` with reason `no sandbox (Docker
  unavailable)`. Not a failure, just unverified.
- **`verify_attestation` says `lookup_failed`:** the grade index or RPC was
  unreachable — that's *unknown*, not *no grade*. Retry; check `POLYGRAPH_API_URL`.

## Grade a skill

Claude Code / Agent **Skills** (a `SKILL.md` plus an optional bundle) are graded by a
separate static litmus (`litmus-skill-v2`). It scans the skill's bytes — **S-01**
prompt injection in the body, **S-03** data-exfiltration instructions, **S-04**
dangerous commands in bundled executable scripts — and content-hashes the whole
directory. The letter is **A/B/D/F**.

This is a **static** scan: it does not execute the skill or its scripts, so an `A`
means the static checks were clean, not that the skill is behaviorally safe. A
command the skill builds or fetches at runtime is not visible to it.

### CLI

```bash
polygraphso-litmus-skill <path-to-skill-dir>          # grade a local skill folder (must contain SKILL.md)
polygraphso-litmus-skill --json <path-to-skill-dir>   # machine-readable safety + quality bundles
```

It also prints a separate, advisory **quality** signal (`well-formed` / `issues` /
`malformed`) — never an A–F letter, never minted. Its deterministic checks
(frontmatter + bundled-link resolution) always run; the optional LLM-judged axes
(honesty, coherence) run only when a judge is available:

- **Inside an agent** (the MCP tool below): the host agent's own model judges via MCP
  sampling — no key, any provider.
- **Standalone:** bring your own key for any OpenAI-compatible endpoint:

  ```bash
  export LITMUS_LLM_API_KEY=…                            # your key (any OpenAI-compatible endpoint)
  export LITMUS_LLM_MODEL=gpt-4o                         # a model the endpoint serves
  export LITMUS_LLM_BASE_URL=https://api.openai.com/v1   # optional; defaults to OpenAI
  # Other providers via their OpenAI-compatible endpoint, e.g.:
  #   Claude:  LITMUS_LLM_BASE_URL=https://api.anthropic.com/v1                       LITMUS_LLM_MODEL=claude-sonnet-4-6
  #   Gemini:  LITMUS_LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai  LITMUS_LLM_MODEL=gemini-2.5-flash
  ```

- With neither, the judged axes are skipped — the grade and deterministic quality
  still run. The core never needs a key.

### From an AI agent (MCP)

The same `polygraphso-litmus-mcp` server exposes two skill tools (plus `grade-skill` /
`check-skill` prompts):

- **`run_skill_litmus`** — grade a local skill directory now (static; uses the host
  model via sampling for the quality axes, no key).
- **`verify_skill_attestation`** — read a skill's *already-published* grade by its
  `skill_ref` (`source/owner/repo#path`, e.g. `github/anthropics/skills#skills/pdf`). It
  returns the attested `contentHash`; recompute the skill's hash and require equality
  before installing — the content hash, not the version, is the trust anchor.

## Library

```ts
import { runLitmus, gateDecision, liveFingerprint, readAttestation } from "@polygraphso/litmus";

const bundle = await runLitmus("npm/@modelcontextprotocol/server-filesystem");
console.log(bundle.grade, bundle.gradeRationale);

// Skills: static safety grade + a separate advisory quality bundle.
import { runSkillLitmus, runSkillQuality } from "@polygraphso/litmus";

const skill = runSkillLitmus("./skills/my-skill");
console.log(skill.grade, skill.contentHash);
```

## License

Apache-2.0
