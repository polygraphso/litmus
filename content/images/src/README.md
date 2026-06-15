# Card generator — source

The shareable cards in `../` are **HTML/CSS mockups rendered to PNG by headless Chromium** — the terminal look is templated (`card.css`), but the *data* is real `litmus-v1` output, so every card is traceable to a reproducible grade. These are not screenshots of a live shell.

## Files

| File | What |
|------|------|
| `card.css` | the shared "terminal" stylesheet (grade cards + leaderboard) |
| `gen-card.mjs` | the generator — data-driven single-grade cards, or render a static HTML |
| `leaderboard.html` | source for `../06-popular-mcp-servers-leaderboard.png` (multi-server, hand-maintained) |
| `reproducibility.html` | source for `../05-reproducibility-same-fingerprint.png` (two runs, hand-maintained) |

## Generate a card

From the repo root:

```bash
# grade a server and render its card (needs Docker for the full C-02 sandbox)
pnpm card npm/@modelcontextprotocol/server-filesystem

# remote target (OAuth) — token is passed only to the target origin
pnpm card https://mcp.deepwiki.com/mcp
pnpm card https://mcp.example.com --bearer "$TOKEN"

# reuse an existing `litmus --json` bundle (no re-run)
pnpm card --from-json /tmp/bundle.json --out content/images/my-card.png

# render a static template (leaderboard / reproducibility)
pnpm card --html content/images/src/leaderboard.html \
  --out content/images/06-popular-mcp-servers-leaderboard.png --size 1620x820
```

Options: `--out <path>`, `--caption "<text>"`, `--size <WxH>` (default `1500x820`), `--from-json <file>`, `--bearer <token>`, `--header "K: V"`. Default output is `content/images/grade-<grade>-<slug>.png`.

> **pnpm + flags:** positional targets forward fine (`pnpm card npm/x`). If pnpm ever swallows a `--flag`, add a `--` separator: `pnpm card npm/x -- --out z.png`. Or call the script directly: `node content/images/src/gen-card.mjs npm/x --out z.png`.

## How a card is built (data → PNG)

1. `litmus <target> --json` → the evidence bundle (`grade`, `categories[].status`, `toolDefsFingerprint`, `gradeRationale`, `serverRef`).
2. `gen-card.mjs` fills the terminal template (CSS inlined) with those values.
3. Headless Chromium screenshots it at 2× → PNG.

## Chromium

Auto-detected from the Playwright browser cache (`~/Library/Caches/ms-playwright` or `~/.cache/ms-playwright`) or a system Chrome/Chromium. Override with `CHROME_BIN=/path/to/chrome`. If none is found, install one: `npx playwright install chromium`.

## Honesty

Cards name third-party servers with real grades — keep captions neutral and probe-cited, never "server X is unsafe." A failing grade is a dated, reproducible behavioral measurement of a specific version, not an accusation. See `../README.md` for the per-server notes.
