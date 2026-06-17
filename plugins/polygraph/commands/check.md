---
description: Read a server's already-published polygraph grade (no run)
argument-hint: <npm/@scope/server>
---
Use the `verify_attestation` tool from the polygraph-litmus MCP server (bundled
with this plugin) to read the published polygraph grade for `$ARGUMENTS`. If it
returns not_available, say the server is unevaluated (neither safe nor unsafe)
and offer to grade it live with /polygraph:grade. If it returns lookup_failed,
say the lookup itself failed so the grade is unknown — do not call it
unevaluated. If the `verify_attestation` tool isn't available, tell me the
polygraph plugin's MCP server hasn't started yet (try /plugin or restart the
session).
