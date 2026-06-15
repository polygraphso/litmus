# Shareable images — week 1

Seven cards rendered from **real litmus-v1 runs** (Docker sandbox, 2026-06-13). Each is a clean terminal render of actual harness output — no mockups. Source HTML/CSS lived in `/tmp/pg-shareables` at render time; the grades are reproducible (re-run the commands in `../twitter-week-1.md` and you'll get the same fingerprint + grade).

Images are 2× (retina) PNGs on a near-black background, sized for X.

| File | Shows | Pairs with | Grade |
|------|-------|-----------|-------|
| `01-grade-f-server-everything.png` | C-03 canary leak → F | Day 1 / Day 2 | F |
| `02-grade-a-server-memory.png` | all three probes pass → A | Day 2 (positive) | A |
| `03-grade-d-context7-egress.png` | C-02 undeclared egress → D | Day 2 (egress swap) | D |
| `04-grade-b-deepwiki-remote.png` | remote over HTTPS, C-02 skipped → B | Day 6 | B |
| `05-reproducibility-same-fingerprint.png` | same server twice, identical fingerprint + grade | Day 3 | A/A |
| `06-popular-mcp-servers-leaderboard.png` | seven popular servers across the full A–F range | research ask / standalone | A–F |
| `07-grade-a-server-filesystem.png` | the most-installed MCP server → A | research ask / Day 2 | A |

## Alt text (paste into X's image description field)

- **01** — Terminal: the litmus harness grading @modelcontextprotocol/server-everything, showing C-01 pass, C-02 pass, C-03 fail, a sha256 fingerprint, and grade F.
- **02** — Terminal: the litmus harness grading @modelcontextprotocol/server-memory, all three categories (C-01, C-02, C-03) passing, grade A.
- **03** — Terminal: the litmus harness grading @upstash/context7-mcp, C-02 (egress) failing while C-01 and C-03 pass, grade D.
- **04** — Terminal: the litmus harness grading the remote server mcp.deepwiki.com over HTTPS, C-02 skipped, grade B, with a note that remote targets cap at B.
- **05** — Terminal: two runs of the litmus harness against the same MCP server, both producing the same sha256 fingerprint and the same grade A.
- **06** — Terminal report card: seven popular MCP servers graded by litmus-v1, spanning A to F, each with its per-category verdicts.
- **07** — Terminal: the litmus harness grading @modelcontextprotocol/server-filesystem (the most-installed MCP server), all three categories passing, grade A.

## Grades captured (2026-06-13, litmus-v1)

| Server | C-01 | C-02 | C-03 | Grade | Fingerprint |
|--------|------|------|------|-------|-------------|
| `npm/@modelcontextprotocol/server-filesystem` | pass | pass | pass | **A** | `0x256a…6db6` |
| `npm/@modelcontextprotocol/server-memory` | pass | pass | pass | **A** | `0x09ea…0eb6` |
| `npm/@modelcontextprotocol/server-sequential-thinking` | pass | pass | pass | **A** | `0x6aea…c3a8` |
| `https://mcp.deepwiki.com/mcp` (remote) | pass | skip | pass | **B** | `0x2e04…191f` |
| `https://gitmcp.io/docs` (remote) | pass | skip | pass | **B** | `0xb766…e9c7` |
| `npm/@upstash/context7-mcp` | pass | fail | pass | **D** | `0x3254…c04a` |
| `npm/@modelcontextprotocol/server-everything` | pass | pass | fail | **F** | `0x068c…4f78` |

## ⚠️ Before posting the leaderboard (06) or the D/F cards (01, 03)

These name third-party servers alongside low grades. Keep the framing **neutral and probe-cited**, never "server X is unsafe":

- `server-everything`'s F is its `get-env` tool returning the planted canary — that's an intentional reference/test server doing what it's built to do, **not** a vulnerability disclosure. Don't imply malice.
- `context7`'s D is real **undeclared egress** to its own backend — legitimate behavior the probe flags, not exfiltration.
- The honest, defensible message is "here is what litmus-v1 measured, and you can re-run it" — which is exactly what the cards show. If in doubt, lead with the A/B cards (02, 04, 05, 07) and use the leaderboard to show the test *discriminates*.

## Website screenshots (polygraph.so, captured 2026-06-13)

Rendered with Playwright (cached Chrome for Testing, 2×, reduced-motion to defeat the scroll-reveal animations). The site is live at https://www.polygraph.so.

| File | Shows | Use |
|------|-------|-----|
| `08-site-hero.png` | hero — "We polygraph AI agents so you don't have to" + live grade card (context7 → D) + CLI install | launch/announce posts |
| `09-site-methodology.png` | §02 "How a tool earns its grade" — the C-01/C-02/C-03 live checks (C-04 deferred to v2) + the A–F grade-scale table | explainer posts |
| `10-site-checks.png` | §03 "Browse the checks we've run" — the live run browser showing mcp.web3auth.io → B | "real runs, published" posts |
| `site-full-page-reference.png` | the entire page, top to bottom (tall) | internal reference, not a standalone share |

### Alt text

- **08** — Screenshot of polygraph.so: headline "We polygraph AI agents so you don't have to," a live litmus-v1 grade card showing @upstash/context7-mcp graded D (tool-output injection pass, permission overreach fail, sensitive-data handling pass), and a CLI install card for `npx polygraphso check`.
- **09** — Screenshot of the polygraph.so methodology section: the three live checks — does it try to hijack your agent (C-01), touch things it shouldn't (C-02), leak your data (C-03) — plus C-04 deferred to v2 and an A–F grade-scale table.
- **10** — Screenshot of the polygraph.so completed-checks section: a live litmus-v1 harness run against the remote server mcp.web3auth.io, graded B with C-02 skipped, fingerprint shown.

## Regenerating these cards (provably reproducible)

All seven cards below were rendered by `content/images/src/gen-card.mjs` from fresh `litmus --json` runs (Docker up). The grades were re-verified deterministic on 2026-06-15 — identical grades **and** fingerprints to the originals. Re-run any of these to reproduce the exact card:

```bash
pnpm card npm/@modelcontextprotocol/server-everything \
  --out content/images/01-grade-f-server-everything.png --size 1500x780 \
  --caption "the harness plants canary secrets and watches what each tool returns. a tool that hands the canary back fails <b>C-03</b> — a dated, reproducible result, not an accusation."

pnpm card npm/@modelcontextprotocol/server-memory \
  --out content/images/02-grade-a-server-memory.png --size 1500x760 \
  --caption "three behavioral probes — injection, egress, sensitive data. pass all three in the sandbox and you get an <b>A</b>. anyone can re-run it and check."

pnpm card npm/@upstash/context7-mcp \
  --out content/images/03-grade-d-context7-egress.png --size 1500x800 \
  --caption "C-02 runs the server in a default-deny sandbox behind a sinkhole. a tool that phones home to its own backend is caught — <b>undeclared egress</b>, not assumed hostile."

pnpm card https://mcp.deepwiki.com/mcp \
  --out content/images/04-grade-b-deepwiki-remote.png --size 1500x820 \
  --caption "point it at a remote MCP server over https and it grades the live tool surface. remote <b>caps at B</b>: egress isn't observable without the sandbox, and the card says so."

pnpm card npm/@modelcontextprotocol/server-filesystem \
  --out content/images/07-grade-a-server-filesystem.png --size 1500x780 \
  --caption "the most-installed MCP server in the ecosystem, run through the litmus harness. clean across all three probes — grade <b>A</b>, and you can re-run it yourself."

# static (multi-server / two-run) cards — rendered from the committed HTML templates
pnpm card --html content/images/src/reproducibility.html \
  --out content/images/05-reproducibility-same-fingerprint.png --size 1500x620
pnpm card --html content/images/src/leaderboard.html \
  --out content/images/06-popular-mcp-servers-leaderboard.png --size 1620x820
```

Note: `pnpm card <target>` re-grades live (needs Docker for the full C-02 sandbox); the grade/fingerprint will match as long as the package's latest published version is unchanged. The leaderboard/reproducibility templates hold their data inline (hand-maintained) — update them if a grade changes.
