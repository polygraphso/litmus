# polygraph (Claude Code plugin)

Grade and verify MCP servers — and Claude Code / Agent **skills** — with the open
[**polygraph litmus**](https://polygraph.so), right from Claude Code. The plugin bundles
the `polygraph-litmus` MCP server and two slash commands (for servers); skill grading is
reachable through the server's skill tools/prompts (below).

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

## Tools and prompts (available to the agent directly)

The bundled MCP server exposes **four** tools — `run_litmus` and `verify_attestation`
(MCP servers), and `run_skill_litmus` and `verify_skill_attestation` (Claude Code
skills) — plus `grade`/`check` and `grade-skill`/`check-skill` prompts. The slash
commands above wrap the server tools; **for skills there is no slash command yet** —
use the `grade-skill` / `check-skill` prompts, or just ask the agent to grade a skill
directory (`run_skill_litmus`) or read a published skill grade (`verify_skill_attestation`).
A skill grade is a static byte-scan (A/B/D/F) anchored by a content hash; an `A` is
static-clean, not behavioral proof.

## Troubleshooting — `run_litmus` / `verify_attestation` not available

- **Restart after enabling.** MCP tools load at session start, so a server
  enabled mid-session won't expose its tools until you restart.
- **Approve it.** A plugin-provided server can sit pending approval — check `/mcp`.
- **Node ≥ 18** is required (the server runs via `npx`).
- **Stale cache.** If `run_litmus` reports a methodology older than `litmus-v10`
  or can't grade skills, `npx` is running an old cached build — reinstall the
  plugin or clear the npx cache to pull the current `@polygraphso/litmus`.
- **Don't reach for `claude mcp add`.** The plugin already provides the server;
  the fix is `/plugin install polygraph@polygraphso` + restart.

Methodology and disclosed limits: [polygraph.so](https://polygraph.so). The
harness is open and deterministic — anyone can re-run a grade and disprove it.
