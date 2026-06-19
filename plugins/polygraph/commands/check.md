---
description: Read a server's already-published polygraph grade (no run)
argument-hint: <npm/@scope/server>
---
Use the `verify_attestation` tool from the polygraph-litmus MCP server (bundled
with this plugin) to read the published polygraph grade for `$ARGUMENTS`. If it
returns not_available, say the server is unevaluated (neither safe nor unsafe)
and offer to grade it live with /polygraph:grade. If it returns lookup_failed,
say the lookup itself failed so the grade is unknown — do not call it
unevaluated. (To read a published **skill** grade, use `verify_skill_attestation`
instead.)

If `verify_attestation` isn't in your available tools, it may just need loading
(some clients surface MCP tools lazily) — try to load it before concluding it's
missing. Only if the polygraph-litmus server genuinely isn't connected, tell me
to enable the plugin (`/plugin install polygraph@polygraphso`, adding the
marketplace first with `/plugin marketplace add polygraphso/litmus` if needed)
and restart the session so the tools load. Do not suggest `claude mcp add` — the
plugin already provides the server.
