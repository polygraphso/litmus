# @polygraphso/litmus

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

## CLI

```bash
polygraphso-litmus litmus <registry-ref | https-url | path-to-mcp>   # grade a server
polygraphso-litmus litmus --json <ref>                              # machine-readable evidence bundle
polygraphso-litmus check <ref>                                      # look up a published grade
```

Examples:

```bash
polygraphso-litmus litmus npm/@modelcontextprotocol/server-filesystem
polygraphso-litmus litmus https://example.com/mcp
```

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
  CLI's `--bearer` / `--header`.
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

**Claude Desktop** (`claude_desktop_config.json`) / **Cursor** (`~/.cursor/mcp.json`):

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

## Library

```ts
import { runLitmus, gateDecision, liveFingerprint, readAttestation } from "@polygraphso/litmus";

const bundle = await runLitmus("npm/@modelcontextprotocol/server-filesystem");
console.log(bundle.grade, bundle.gradeRationale);
```

## License

Apache-2.0
