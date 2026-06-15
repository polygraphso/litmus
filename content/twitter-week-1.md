# Twitter — Week 1 (7 days)

A ready-to-schedule week for @polygraphso. Each day = **a claim + its receipt** (a real screenshot). Drafts are in the project voice; capture commands and alt text are included so you can batch the images in one sitting.

> **Pre-rendered images are ready** in [`images/`](./images/) — seven cards rendered from real litmus-v1 runs (2026-06-13), with the day-by-day mapping and alt text in [`images/README.md`](./images/README.md). You can attach those directly; the per-day capture commands below remain if you'd rather grab a fresh terminal shot.

---

## Rails (read once)

- **Voice:** serious, calm, plain English — "scientific preprint." Lowercase is fine (matches the house style). Never "revolutionize," no web3/VC-bro, no "AI safety" framing, no "100% safe / guaranteed."
- **Status honesty:** the hosted *grader* runs; the *product* isn't live yet (web app integration — mint/pay/display — is pending). Say "shipped a grader," not "launched."
- **Reproducibility, not unforgeability:** v1 trust rests on the open, deterministic harness being re-runnable. TEE / zkTLS / staked bond / independent re-run are **roadmap** — name them, don't imply them.
- **Frame receipts as the *probe* catching a *behavior*, never "server X is unsafe."** context7 legitimately calls home; `server-everything`'s `get-env` returns env by design (it's a reference server). The harness flags *undeclared* behavior — it does not allege malice. Naming-and-shaming a third-party project is wrong and an own-goal.
- **Char limit:** every single tweet below is verified ≤ 280 — exact count noted per day (em dash `—` and arrow `→` each count as 1 character on X). Threads are marked, and each tweet within a thread is also ≤ 280.
- **Every image gets alt text** (provided per day). **Keep tokens, secret env values, and internal hostnames out of frame** — use `$LITMUS_RUNS_TOKEN`, never the literal.
- **Tagging:** put teammate credit in a **self-reply** to the day's tweet (keeps the main tweet tight, still notifies them → they amplify). Tag co-builders only, not big accounts for reach.

---

## Capture checklist (batch these once)

Grades below are from the verified demo set (confirmed 2026-06-11, deterministic). The hosted service grades the **latest** published npm version — re-run at capture time and, if a grade differs, make the tweet copy match what you actually captured.

```bash
# Day 1 — hosted service, real grade over HTTP (set token in env; keep it out of frame)
export BASE="https://hosted.polygraph.so"
export LITMUS_RUNS_TOKEN="<your runs token>"
ID=$(curl -sS -X POST "$BASE/grade" -H "authorization: Bearer $LITMUS_RUNS_TOKEN" \
  -H "content-type: application/json" \
  -d '{"target":"npm/@modelcontextprotocol/server-everything"}' | jq -r .id)
# poll until done, then: curl -sS "$BASE/grade/$ID" -H "authorization: Bearer $LITMUS_RUNS_TOKEN" | jq .
# → expect "grade": "F"

# Day 2 — local card, C-03 canary fail (richer: category verdicts + fingerprint)
npx tsx packages/cli/src/cli.ts litmus npm/@modelcontextprotocol/server-everything 2>/dev/null   # → F

# Day 3 — reproducibility: run the SAME target twice, show identical fingerprint + grade
npx tsx packages/cli/src/cli.ts litmus npm/@modelcontextprotocol/server-memory 2>/dev/null        # → A
npx tsx packages/cli/src/cli.ts litmus npm/@modelcontextprotocol/server-memory 2>/dev/null        # → A (same fingerprint)

# Day 5 — fingerprint up close (bytes32) — any card works; server-memory is clean
npx tsx packages/cli/src/cli.ts litmus npm/@modelcontextprotocol/server-memory 2>/dev/null

# Day 6 — remote grading over HTTPS (public, no token needed)
npx tsx packages/cli/src/cli.ts litmus https://mcp.deepwiki.com/mcp 2>/dev/null                    # → B

# Day 2 alt / egress receipt (optional swap): C-02 egress caught
npx tsx packages/cli/src/cli.ts litmus npm/@upstash/context7-mcp 2>/dev/null                       # → D
```

⚠️ **Verify before posting:**
- **Day 7 (agent gate):** confirm `packages/agent/src/scripts/mint-and-gate.ts` still runs cleanly post-refactor and produces a visible "refused" before you screenshot/record it. A fallback (no-screenshot) draft is provided.
- **On-chain attestation tweet (held for later):** minting is the web app's job and isn't wired into the hosted path — only post an EAS/BaseScan screenshot if you have a real attestation to point at. Not in this week.

---

## Day 1 — Ship: the hosted grader

**Theme:** build update / what shipped.

> new at @polygraphso: a hosted grader for MCP servers. point it at one, it runs our open litmus harness in a sandbox and grades what the tool does — hijack, phone home, leak. no signing key on the box, so anyone can re-run a grade and disprove it. wiring it into the app next.

- **Image:** Day 1 hosted curl → `"grade": "F"`.
- **Alt text:** Terminal: a curl request to polygraph's hosted grader runs the litmus harness on the npm MCP server @modelcontextprotocol/server-everything, polling until status is "done." The JSON response shows grade F, with a server reference and a hosted run id.
- **Self-reply (tag team):** `built by @<handle> @<handle>` — fill in the people who shipped it.
- **Count:** 275 chars.

---

## Day 2 — How it works: the C-03 probe

**Theme:** methodology / educational.

> how litmus grades a tool's data handling: it plants canary secrets in the env, exercises every tool, and watches what comes back. a tool that hands the canary back is a C-03 fail. here's the harness catching exactly that — reproducible, not an accusation.

- **Image:** local CLI card for `server-everything` — the C-03 fail line, the grade, and the fingerprint visible.
- **Alt text:** Terminal: the litmus harness grading an MCP server, showing per-category verdicts (C-01, C-02, C-03), a sha256 tool fingerprint, and an overall grade of F, with C-03 (sensitive-data handling) failing.
- **Swap option:** if you'd rather lead with egress, use the `context7-mcp → D` card and reword to "a tool that phones home to its own backend is a C-02 fail — flagged as undeclared egress, not assumed hostile."
- **Count:** 254 chars.

---

## Day 3 — Reproducibility (the core trust claim)

**Theme:** why you don't have to trust us.

> the point of an open eval: a grade you don't have to trust us for. run the harness twice against the same server — same tool fingerprint, same grade, every time. that's what makes a false grade falsifiable. anyone can re-run it and prove it wrong.

- **Image:** two runs of `server-memory` side by side, identical `0x…` fingerprint and identical grade.
- **Alt text:** Terminal: the litmus harness run twice against the same MCP server, both runs producing the same sha256 tool fingerprint and the same grade A — demonstrating a deterministic, reproducible result.
- **Count:** 247 chars. Strongest on-brand image of the week.

---

## Day 4 — The honest trade-offs (thread)

**Theme:** the "preprint" pillar — building trust by underclaiming. Post as a native thread. **Counts:** 119 / 219 / 186 / 148 / ~85 chars (each tweet ≤ 280).

> 1/ what a litmus-v1 grade is — and what it isn't. a short thread, because the honest limits matter more than the pitch.

> 2/ it's a reproducible self-test. trust rests on reproducibility: the harness is open and deterministic, so a false grade is falsifiable — anyone can re-run it and disprove the lie. that's the floor, and it's universal.

> 3/ what it isn't: unforgeable. today's grade is self- or operator-run — nothing yet stops a patched harness from writing a grade it didn't earn. we disclose this; we don't paper over it.

> 4/ the ladder up, strongest-last: economic consequence → zkTLS web-proofs → TEE attestation → independent re-run. each additive, named, not implied.

> 5/ we ship the open floor first. unforgeability is roadmap. underclaim, over-deliver.

- **Image (optional, tweet 4):** a simple text ladder graphic — `reproducibility → consequence → zkTLS → TEE → independence`. Skip if you don't have a clean one; the thread stands alone.
- **Alt text (if used):** A five-rung ladder labeled, bottom to top: reproducibility, economic consequence, zkTLS web-proofs, TEE attestation, independent re-run.

---

## Day 5 — Fingerprint & rug-pull resistance

**Theme:** the mechanism that makes a grade un-swappable.

> every litmus grade is bound to a fingerprint of the exact tool surface: tools/list → canonical json → sha256. change the tools after you're graded and the fingerprint changes — a consuming agent sees the mismatch and refuses. graded-then-swapped is the rug pull this catches.

- **Image:** the `0x…` `toolDefsFingerprint` on a grade card (close-up). Bonus: two cards with *different* fingerprints to show a changed surface.
- **Alt text:** Terminal: a litmus grade card showing a bytes32 tool-definitions fingerprint (a sha256 of the server's canonical tool list) bound to the grade.
- **Count:** 275 chars. (Note: the fingerprint is still a `bytes32` — that detail moved to the card/image to save room; the copy keeps the derivation `tools/list → canonical json → sha256`.)

---

## Day 6 — Real-world reach: remote servers

**Theme:** it's not just local toy packages.

> it's not just local npm packages. point litmus at a remote MCP server over https and it grades the live tool surface the same way. remote caps at B for now — egress isn't observable without the sandbox — and the card says so plainly.

- **Image:** `mcp.deepwiki.com/mcp → B` card (public remote, no token needed → clean to screenshot).
- **Alt text:** Terminal: the litmus harness grading a remote MCP server over HTTPS (DeepWiki), producing grade B, with a note that remote targets cap at B because egress is not observable without the sandbox.
- **Count:** 233 chars. If you want to show the OAuth path instead, do it as a follow-up day with the "token sent only to the target origin; state-changing tools skipped by default" angle — but don't put any real token on screen.

---

## Day 7 — Why it matters: the agent gate

**Theme:** the payoff — the consumer side, the moment of consequence.

> the consumer side, and the reason any of this matters: before an agent trusts a tool with money, secrets, or write access, it reads the grade, re-checks the live fingerprint, and refuses on a failing grade or a mismatch. here's an agent declining to act on an F.

- **Count:** main tweet 262 chars; fallback 255 chars.
- **Image / GIF:** the agent-gate refusing. ⚠️ **Verify `mint-and-gate.ts` runs and shows a clear "refused" first.**
- **Alt text:** Terminal: an agent reads an MCP server's litmus grade, re-checks the live tool fingerprint, and refuses to proceed because the grade is failing.
- **Fallback (if the gate isn't capture-ready):** post without an image —
  > the wedge is the moment of consequence: the call that moves money, spends a secret, or writes. that's where "looks popular" stops being good enough — popularity was never a behavioral property. a grade an agent can re-check is. that's what we're building.

---

## Reuse notes

- **Repurpose to LinkedIn:** Day 4 (trade-offs) and Day 2/3 (how it works) carry over well as a short LinkedIn post; lead with the same first line, drop the lowercase if it reads odd there.
- **Keep a few in reserve:** the OAuth-grading build log, the C-02/sinkhole deep-dive, and the EAS/on-chain tweet (once minting is wired) are next week's material.
- **Engagement:** reply to every reply for the first hour; that's where reach compounds more than posting cadence.
