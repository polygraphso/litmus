---
description: Grade an MCP server A–F with the open polygraph litmus (runs the harness)
argument-hint: <npm/@scope/server | https-url | path-to-mcp>
---
Run the polygraph litmus on `$ARGUMENTS` using the `run_litmus` tool from the
polygraph-litmus MCP server (bundled with this plugin). Report the letter grade,
the one-line summary, and any failed category with its findings. If the grade is
capped at B because Docker was unavailable, say so plainly.

`run_litmus` grades MCP **servers**, not skills. If `$ARGUMENTS` is a skill (a
skill directory, or a request to grade or validate a skill), use the skill path
instead — the `run_skill_litmus` tool or the `grade-skill` prompt — not
`run_litmus`.

If `run_litmus` isn't in your available tools, it may just need loading (some
clients surface MCP tools lazily) — try to load it before concluding it's
missing. Only if the polygraph-litmus server genuinely isn't connected, tell me
to enable the plugin (`/plugin install polygraph@polygraphso`, adding the
marketplace first with `/plugin marketplace add polygraphso/litmus` if needed)
and restart the session so the tools load. Do not suggest `claude mcp add` — the
plugin already provides the server.
