# test-fixtures

Deterministic, **intentionally bad** fixtures used by the probe and skill tests.
They contain inert, clearly-fake payloads (`*.example.com` sinks, no real hosts)
and are **scanned as bytes, never executed**. Do not "fix" them — failing them is
the point.

- `leaky-bin-mcp/` — an MCP server fixture that leaks a planted canary (C-03 path).
- `demo-evil-skill/` — a skill that should grade **F**: a `<system>` instruction
  override and a `javascript:` URI (S-01), a `.env` exfil instruction to a remote
  URL (S-03), and a `curl … | sudo bash` in a bundled script (S-04).
- `demo-overreach-skill/` — a skill that should grade **D**: a benign body whose
  only fault is a `curl … | bash` remote-exec in a bundled script (S-04 caps at D).
