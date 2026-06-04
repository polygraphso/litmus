# @polygraphso/litmus

The behavioral **litmus** harness for MCP servers, from [polygraph.so](https://polygraph.so).

It connects to an MCP server the way an agent would, fingerprints its exact tool
surface, and runs three probe categories — **C-01** tool-output injection, **C-02**
permission/egress (in a hardened default-deny Docker sandbox), **C-03**
sensitive-data handling (planted canaries) — then grades the server **A–F**. With
an API URL configured it pins a deterministic evidence bundle and hands off to a
browser flow where you sign an onchain attestation backed by a USDC bond.

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
polygraphso-litmus challenge <attestation-uid> <ref>                # re-run to dispute a published grade
polygraphso-litmus check <ref>                                      # look up a published grade
```

Examples:

```bash
polygraphso-litmus litmus npm/@modelcontextprotocol/server-filesystem
polygraphso-litmus litmus https://example.com/mcp
```

The `litmus` command exits non-zero on a failing grade (D/F), so it scripts in CI.
Set `POLYGRAPH_API_URL` to pin the evidence bundle and print a mint hand-off link.

## Use it from an AI agent (MCP server)

The package ships a stdio MCP server, `polygraphso-litmus-mcp`, so it works in any
MCP-capable client. It exposes two tools:

- **`run_litmus`** — actively grade a server *now* (runs the harness end-to-end),
  and return the grade, the evidence, and a mint hand-off URL.
- **`verify_attestation`** — passively read a server's *already-published* grade
  before trusting or paying it.

**Prerequisites:** Node ≥ 18. Docker is optional (without it, C-02 egress is
skipped and the grade caps at B). Set `POLYGRAPH_API_URL=https://polygraph.so` to
enable the pin + mint hand-off.

Add the server once, then just talk to your agent.

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
C-01/C-02/C-03, and returns the **grade (A–F)**, the per-category results, the
tool-surface fingerprint, and — when `POLYGRAPH_API_URL` is set — a **`mint` URL**.
Open that URL in a browser, connect your wallet, and sign to publish the grade
onchain and stake the bond. Signing is intentionally **not** headless: the agent
does the work, you approve the mint. Use **`verify_attestation`** instead to read a
grade that's already published.

`run_litmus` launches the target server's code to exercise it (egress-sandboxed
when Docker is present). It needs no wallet or RPC; only minting does.

## Library

```ts
import { runLitmus, gateDecision, liveFingerprint, readAttestation } from "@polygraphso/litmus";

const bundle = await runLitmus("npm/@modelcontextprotocol/server-filesystem");
console.log(bundle.grade, bundle.gradeRationale);
```

## License

Apache-2.0
