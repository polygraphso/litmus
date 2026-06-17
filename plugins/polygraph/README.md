# polygraph (Claude Code plugin)

Grade and verify MCP servers with the open [**polygraph litmus**](https://polygraph.so),
right from Claude Code. The plugin bundles the `polygraph-litmus` MCP server and
two slash commands.

## Install

```
/plugin marketplace add polygraphso/litmus
/plugin install polygraph@polygraphso
```

Installing enables the bundled `polygraph-litmus` MCP server automatically (it
runs `npx -y -p @polygraphso/litmus polygraphso-litmus-mcp`, so it needs Node
≥ 18; Docker is optional — without it, the C-02 egress check is skipped and the
grade caps at B).

## Commands

- **`/polygraph:grade <ref>`** — actively grade a server now (runs the harness
  end-to-end): A–F across C-01 tool-output injection, C-02 permission/egress,
  C-03 sensitive-data, C-04 adversarial-input. `<ref>` is an npm ref
  (`npm/@scope/server`), an `https://` MCP URL, or a local path to an MCP entry.
  ```
  /polygraph:grade npm/@modelcontextprotocol/server-filesystem
  ```
- **`/polygraph:check <ref>`** — read a server's already-published grade without
  running anything. (Grade publishing is still rolling out, so this commonly
  returns `not_available` today — that means *unevaluated*, not a failing grade.)

## Tools (also available to the agent directly)

The bundled MCP server exposes `run_litmus` and `verify_attestation`, plus
`grade`/`check` prompts. The slash commands above are thin wrappers over these.

Methodology and disclosed limits: [polygraph.so](https://polygraph.so). The
harness is open and deterministic — anyone can re-run a grade and disprove it.
