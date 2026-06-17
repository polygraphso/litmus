---
description: Grade an MCP server A–F with the open polygraph litmus (runs the harness)
argument-hint: <npm/@scope/server | https-url | path-to-mcp>
---
Run the polygraph litmus on `$ARGUMENTS` using the `run_litmus` tool from the
polygraph-litmus MCP server (bundled with this plugin). Report the letter grade,
the one-line summary, and any failed category with its findings. If the grade is
capped at B because Docker was unavailable, say so plainly. If the `run_litmus`
tool isn't available, tell me the polygraph plugin's MCP server hasn't started
yet (try /plugin or restart the session).
