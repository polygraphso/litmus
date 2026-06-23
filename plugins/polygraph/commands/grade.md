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

## Token-gated servers

If the target is an `https://` URL and `run_litmus` fails to connect because the
server is token-gated (an auth error such as `401`, `invalid_token`, or "No
authorization provided"), litmus needs a bearer token — it connects as a fresh,
independent client, so it has none of the user's existing session.

Don't immediately ask the user to paste one. First look for the token they
already have: the same MCP client config that makes this server work in their
agent. Only when that fails should you ask.

1. If the user already supplied a token (in `$ARGUMENTS` or the conversation),
   use it directly — skip discovery.
2. Otherwise, check the config files that exist and find the entry whose URL
   matches the target (ignore a trailing-slash difference). Common locations:
   project `./.mcp.json`, `./.cursor/mcp.json`, `./.vscode/mcp.json`; user-level
   `~/.claude.json`, the Claude Desktop config
   (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
   the equivalent for the platform), and `~/.cursor/mcp.json`. Read that entry's
   `headers`, resolving any `${VAR}` placeholder from the environment.
3. If found, confirm before using it: name the source file, **never print the
   token value**, and state plainly that grading will make live, authenticated
   tool calls to the server **as the user** (read-only tools only). On
   confirmation, re-run `run_litmus` passing the token as `bearer` (strip a
   leading `Bearer `), or as a `header` `"Key: Value"` for a non-`Authorization`
   scheme.
4. If nothing is found, the server may use OAuth. Tell the user a browser window
   will open for them to log in, then re-run `run_litmus` with
   `interactive_auth: true` — litmus opens the browser, captures the token via a
   local `127.0.0.1` callback, and uses it for this run only (never stored). If
   the user declines, or the server isn't OAuth, ask for a bearer token and say
   why: litmus connects as a fresh client and needs the same token their agent
   already uses for this server.

Never pass `unsafe_host_exec`, and never enable state-changing calls just to get
past auth.

If `run_litmus` isn't in your available tools, it may just need loading (some
clients surface MCP tools lazily) — try to load it before concluding it's
missing. Only if the polygraph-litmus server genuinely isn't connected, tell me
to enable the plugin (`/plugin install polygraph@polygraphso`, adding the
marketplace first with `/plugin marketplace add polygraphso/litmus` if needed)
and restart the session so the tools load. Do not suggest `claude mcp add` — the
plugin already provides the server.
