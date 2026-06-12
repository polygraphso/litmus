# The Litmus Test — v1

**`methodologyVersion: "litmus-v1"`** · Status: specification · Companion: [`onchain-proof-spec.md`](./onchain-proof-spec.md), [`technical-design.md`](./technical-design.md)

> This is the **standalone, authoritative methodology** for `litmus-v1`. It is self-contained — it does not modify or depend on any other file in the repo.

---

## 1. What the litmus test measures

The litmus test is a **behavioral evaluation of an MCP server** — not a metadata score. It connects to the server the way an agent would, exercises its tools, and watches what the server actually *does*: whether its outputs try to hijack the calling agent, whether it reaches out over the network when it had no reason to, and whether data handed to it leaks back out.

It answers one question an agent needs answered before it trusts (and, in agentic commerce, *pays*) a tool:

> **Will this MCP server hijack me, phone home, or leak my data?**

It does **not** measure popularity, code quality, maintenance, or licensing — those are the separate *adoption score* (`packages/scoring`). The litmus grade is the behavioral half of a server's polygraph.

### What a passing grade does and does not claim
- It **does** claim: against `litmus-v1`, on the exact tool surface identified by the fingerprint, the server did not exhibit the failure modes below, and the evidence is published and re-runnable.
- It **does not** claim the server is "safe," "secure," or "trustworthy" in general. We underclaim. A grade is a dated, versioned, reproducible observation — nothing more. (See §8.)

---

## 2. Categories and probes

v1 ships **five probes across three categories**. Each probe has a stable ID that carries its **family number** (1 = injection, 2 = permission, 3 = adversarial input, 4 = sensitive data). Section codes `C-01…C-04` are assigned in *shipping-first display order*, which is why they don't line up with the family numbers — the mapping is fixed below.

| Code | Category | Probe family | v1 probes | Status |
|---|---|---|---|---|
| **C-01** | Tool-output injection | 1 | 1.1, 1.2 | ships v1 |
| **C-02** | Permission overreach | 2 | 2.2 | ships v1 |
| **C-03** | Sensitive-data handling | 4 | 4.1, 4.2 | ships v1 |
| **C-04** | Adversarial input handling | 3 | — | **v2 · deferred** |

Probe IDs are permanent; future probes extend a family (e.g. `2.1`, `1.3`) without renumbering existing ones.

---

### C-01 — Tool-output injection (family 1)

**Threat.** An MCP server's tool *descriptions* and tool *outputs* flow straight into the calling agent's context. A hostile or compromised server can embed instructions there to hijack the agent — the documented "tool poisoning" class of attack. This is the lie-detector at the heart of the polygraph.

**Probe 1.1 — Static description scan.** Pull the full tool surface via `tools/list`. Scan every tool `name`, `description`, and `inputSchema` text with the §3 scanners. No tool calls required; deterministic.

**Probe 1.2 — Dynamic output scan.** For each tool, issue a small battery of **bait calls**: benign-but-suggestive inputs designed to elicit injection-shaped echoes (e.g. asking an echo/fetch/summarize tool to return attacker-controlled text). Scan every `result.content[].text` and structured output with the same scanners.

**Fail criteria (either probe).** Any **high-severity** scanner hit:
- **Instruction mimicry** aimed at the agent — imperative directives ("ignore previous instructions", "you must", "system:"), tool-call-shaped JSON embedded in free text, role-play/override framing.
- **Hidden / invisible Unicode** — zero-width (`U+200B–U+200D`, `U+FEFF`), bidi overrides (`U+202A–U+202E`, `U+2066–U+2069`), Unicode tag chars (`U+E0000–U+E007F`).
- **Markdown / link tricks** — `javascript:` or `data:` URIs, links whose visible text contradicts the href, image URLs with exfiltration-shaped query strings.

**Evidence.** Offending tool name, the matched substring (with a hex dump for invisible chars), probe ID, severity.

---

### C-02 — Permission overreach (family 2)

**Threat.** A tool may quietly reach the network — phone home, fetch a payload, exfiltrate — when nothing in the requested operation required it. "Touches more than it claimed."

**Probe 2.2 — No-expected-egress run.** Run the server inside a **default-deny network namespace** (see §4) and exercise its tools through a script that *should* require no outbound traffic. Any outbound connection attempt is a finding. We **deny and record**: egress is routed to a local sinkhole that logs `{host, port, firstBytes}` and never completes the connection, so the evidence shows *what it tried to reach* rather than a silent block.

**Fail criteria.** Any logged outbound connection attempt during a no-expected-egress run.

**Applicability.** C-02 requires that the harness *runs the server itself* (a local npm/pypi package). For a **remote MCP URL** the harness cannot control the server's network, so C-02 is recorded as **`skipped` (reason: remote target)** — it is not a pass. When **Docker is unavailable**, C-02 is **`skipped` (reason: no sandbox)**; see the grade cap in §5.

**Evidence.** The sinkhole connection log (host/port/first-bytes per attempt), or the explicit skip reason.

---

### C-03 — Sensitive-data handling (family 4)

**Threat.** Data the agent hands a tool — arguments, files in the working directory, environment — should not leak, neither back to the agent in tool output nor out over the network.

Before any calls, the harness plants **canaries**: a distinctive fake API key (`POLYGRAPH-CANARY-<uuid>`), a distinctive PII string, and a fake bearer token. In the sandboxed path these are also seeded into the working directory and environment so a file/secret-reading tool can surface them.

**Probe 4.1 — Output leak.** Scan all tool outputs for any canary echo (leak back to the agent).

**Probe 4.2 — Egress leak.** Scan the captured egress (the same sinkhole log as C-02) for canary bytes in any outbound payload. Requires the sandbox; without it, 4.2 degrades to **`partial` (output-scan only, no egress capture)** and is annotated as such.

**Fail criteria.** A canary appears anywhere it should not — in output (4.1) or in attempted egress (4.2).

**Evidence.** Which canary, where it surfaced, the surrounding context, probe ID.

---

### C-04 — Adversarial input handling (family 3) — **deferred to v2**

How the server behaves under malformed inputs, oversized payloads, and known jailbreak patterns. The deterministic battery (C-01/C-02/C-03) ships first; this category waits for the harness to mature. Marked `v2 · deferred`. **Not graded in v1.**

---

## 3. Shared scanners

The detection primitives used by C-01 and C-03, implemented once (`packages/probes/src/probes/scanners.ts`) and applied uniformly:

- **`invisibleUnicode(text)`** — flags zero-width, bidi-override, and tag-char codepoints; returns each with its codepoint and byte offset.
- **`instructionMimicry(text)`** — pattern set for agent-directed imperatives, override/jailbreak framing, and free-text tool-call JSON.
- **`markdownTricks(text)`** — `javascript:`/`data:` URIs, link-text/href mismatch, exfil-shaped image URLs.
- **`canaryMatch(text, canaries)`** — exact and lightly-obfuscated (case, whitespace, simple encodings) match of planted markers.

Each returns structured findings `{ kind, severity, match, offset }`; probes decide pass/fail from severity. Scanners are pure functions over text — independently unit-testable and the place new failure modes are added.

---

## 4. Execution environment

- **Connection.** Via the MCP TypeScript SDK. Local npm/pypi packages are launched and spoken to over **stdio**; a remote server is reached over **Streamable HTTP**. The harness performs the normal `initialize` handshake, then `tools/list`, then probe-driven `tools/call`.
- **Authenticated remotes.** An **OAuth-gated** remote server is reached by passing credentials as HTTP headers — `--bearer <token>`, repeatable `--header "Key: Value"`, or the `LITMUS_BEARER` env var — injected on every request to that server. The token is sent **only to the target origin** (a cross-origin request strips it). v1 does **not** run an interactive OAuth authorization-code flow; the caller supplies the token. See the reproducibility caveat in §6.
- **Safety: state-changing tools.** The dynamic probes (1.2, 4.1) call tools with bait inputs. Tools that look state-changing — flagged by MCP `destructiveHint` / `readOnlyHint:false` annotations, or by a conservative verb heuristic on the tool *name* (`send`, `swap`, `sign`, `transfer`, `delete`, `create`, …) — are **not** actively called by default, so the harness cannot move funds or mutate state on an authenticated server. They are still fingerprinted and statically scanned (1.1), and recorded as **skipped (state-changing)**, not passed. `--allow-state-changing` opts into exercising the full surface.
- **Sandbox (C-02, and 4.2).** The target package is installed in a prep step (network on), then probed with egress routed to the local sinkhole (default-deny + capture). The sandbox is a local Docker container; the user runs it on their own machine.
- **Graceful degradation.** C-01 and probe 4.1 are response-inspection and run anywhere, no Docker required. C-02 and probe 4.2 require the sandbox and are explicitly `skipped`/`partial` (with reason) when it is unavailable — never silently dropped.

---

## 5. Grading rubric

A single letter **A–F**, always accompanied by a rationale string (never a bare letter).

| Condition | Grade |
|---|---|
| Any **C-01** or **C-03** failure (active injection or data leak) | **F** |
| **C-02** failure (unexpected egress), no C-01/C-03 failure | **D** (capped) |
| All three categories **pass** | **A** |
| C-01 and C-03 pass, **C-02 `skipped`** (no sandbox / remote target) | **B** |

Rationale: injection and data-leak are disqualifying — they are the failures that directly harm an agent that trusts the server, so they floor the grade at F. Unexpected egress is serious but not necessarily exfiltration, so it caps at D. The **B** tier keeps the no-Docker path usable while stating honestly that egress was not verified. Every grade carries its reasons in the evidence bundle.

`uint8` category encoding for the attestation: `0 = pass`, `1 = fail`, `2 = skipped`. (See `onchain-proof-spec.md`.)

---

## 6. Reproducibility contract

This is what makes a grade trustworthy rather than an assertion — especially in v1, where the runner is self-serve (the subject runs the harness on itself).

1. **Deterministic harness.** Same server version + same `litmus-v1` harness → same findings. No randomness in probe inputs or scanners; timestamps and environment are recorded, not baked into verdicts.
2. **Tool-defs fingerprint.** The canonicalized tool surface (`tools/list`) is hashed to a `bytes32` (`toolDefsFingerprint`). The grade certifies *that exact surface*. If the server later changes a tool description — a rug pull — the fingerprint no longer matches and the grade is stale by construction.
3. **Published evidence.** The full evidence bundle (every finding, every artifact) is pinned to IPFS and referenced by the onchain attestation. Anyone can fetch it.
4. **Re-runnable.** The methodology and harness are open source. Anyone — a skeptic, a counterparty, a future independent verifier — can re-run `litmus-v1` against the same server and compare fingerprint + grade. A false self-grade is therefore *falsifiable*, not merely disputable.

**Caveat — authenticated targets.** For an OAuth-gated server, reproducibility is **credential-scoped**: the grade certifies the surface and behavior reachable *with the token that was supplied*, and a re-run needs equivalent credentials. A third party holding their own valid credentials can still re-run and compare; a party with no access cannot replay a private token — so an authenticated grade is "reproducible-in-context," weaker than the universal re-runnability of a public server. State-changing tools skipped for safety are recorded as such, so a re-run with `--allow-state-changing` may legitimately widen coverage. The evidence bundle records that the run was authenticated so consumers can read the grade with this scope in mind.

The evidence-bundle shape and the verification walk-through live in [`onchain-proof-spec.md`](./onchain-proof-spec.md).

---

## 7. Threat model & limits (v1)

A grade is meaningful only against a stated threat model. Two properties decide whether one can be trusted, and they are independent:

**Forgeability — can the minter fake the result?** This is *not* a methodology question; it's fixed by the proof layer. Plain self-mint is forgeable; reproducibility (the v1 layer) makes a lie *falsifiable*, and the roadmap layers — a USDC challenge bond / zkTLS / TEE / independent re-run — make it *unprofitable* or *impossible*. Full treatment: [`onchain-proof-spec.md`](./onchain-proof-spec.md) §1, §9.

**Evasion — can the server tell it's being tested and behave?** This *is* a methodology limit, and a fundamental one. Because the methodology is open, a server can recognize the test context — the shape of the bait inputs, the canary pattern, a default-deny network, the absence of a real agent — and behave benignly during evaluation, then misbehave in production (a "defeat device," cf. Dieselgate). **No proof layer fixes this**; an independent lab running the same open test has the same exposure. We reduce, not eliminate, the gap:

- **Randomize what's randomizable.** Canary values are per-run unique; bait inputs draw from a varied pool, so a static signature match is harder. (The *technique* is still public — a determined evader can still detect the context.)
- **Behavioral, not just static.** Probe 1.2 exercises tools and inspects real outputs — harder to fake than reading descriptions.
- **Continuous + live re-checks.** Grades expire; re-attestation is required periodically and can be triggered by consumers, so "behave once at mint" is not enough.
- **Live-fingerprint check at call time.** The cheapest, most important defense against the *bait-and-switch* form (pass with one tool surface, serve another): the consumer recomputes the live `toolDefsFingerprint` and rejects any mismatch with the attestation. Specified for the agent-gate in [`onchain-proof-spec.md`](./onchain-proof-spec.md) §7 and [`technical-design.md`](./technical-design.md) §6.

Evasion is an **explicitly acknowledged residual risk** of v1 — mitigated, not closed.

**C-02 egress capture is DNS-routed (IP-literal / DoH evasion).** The C-02 sandbox detects an outbound attempt by answering every DNS lookup with the sinkhole's address and funnelling the resulting connection to a logger. A target that connects to a **hard-coded IP literal** — or uses DNS-over-HTTPS/TLS to a hard-coded resolver IP — issues no sinkholed lookup, so its packets are dropped by the `--internal` network and never recorded; C-02 (probe 2.2) and the 4.2 canary-egress scan then read as a clean *pass*. The real data still never leaves the box (`--internal` blocks all egress), so this is a **capture-completeness / false-pass limit on the grade**, not an exfiltration path — and unlike the evasion residual above it needs no test-context detection (a target can simply hard-code an address; we already close the analogous IPv6 dodge by disabling IPv6 in the target). Closing it requires capture that does not depend on DNS — e.g. making the sink the network's default gateway and DNAT-ing all forwarded egress to the logger, so an IP-literal attempt is captured regardless. That re-architecture is **roadmap**; v1 records this as a known limit.

### Non-goals

- **Not independence.** v1 is self-run and self-minted: the subject grades itself. Independence — polygraph's stated moat — is **knowingly traded** here for cost and decentralization. The MVP anchors trust on **reproducibility** — the open harness makes a false grade falsifiable; skin-in-the-game (a USDC challenge bond) and full independence (lab counter-attestation, zkTLS/TEE) stay on the roadmap ([`onchain-proof-spec.md`](./onchain-proof-spec.md) §9). A v1 grade is a "reproducible self-test," not an "independent verdict." Say so plainly. (The hosted service's operator-run mode takes the run out of the subject's hands without changing this methodology or buying independence — [`hosted-service.md`](./hosted-service.md).)
- **Not secrets management.** Auditing how a server stores or rotates its own secrets is **out of scope** for v1. (Do not re-add without updating this spec first.)
- **Not adversarial input.** Family 3 / C-04 is deferred (see §2).
- **Bounded surface.** We probe the advertised tool surface at evaluation time. Tools gated behind auth/state we cannot reach are recorded as unexercised, not passed. Tools we *decline* to call for safety — state-changing tools, by default (see §4) — are likewise recorded as skipped, not passed; `--allow-state-changing` removes that bound.
- **No absolute claims.** Never "100% safe" or "guaranteed." Underclaim, over-deliver.

---

## 8. Versioning

- This document is `litmus-v1`. The string `methodologyVersion: "litmus-v1"` is embedded in every evidence bundle and every attestation, so a grade is always tied to the methodology that produced it.
- Probes evolve as agents do; new failure modes get new probe IDs within their family. A change that alters pass/fail semantics bumps the methodology version (`litmus-v2`).
- Changelog lives at the bottom of this file as versions ship.

### Changelog
- **litmus-v1.2** — OAuth-gated targets can now be graded by passing credentials as HTTP headers (`--bearer` / `--header` / `LITMUS_BEARER`), sent only to the target origin (§4); no grading-rubric change (§5 untouched; `methodologyVersion` stays `litmus-v1`). With authentication comes a safety bound: the dynamic probes (1.2, 4.1) no longer actively call tools classified as **state-changing** (by MCP annotations or a name verb-heuristic) by default — they are recorded as skipped, not passed, so the harness can't move funds or mutate state on a live server; `--allow-state-changing` restores full exercise (§4, §7 "Bounded surface"). This trades some default detection coverage for safety: a state-changing tool that would misbehave on a bait call is, by default, not caught — a re-run with `--allow-state-changing` may move such a grade. Reproducibility of an authenticated grade is credential-scoped (§6 caveat). Not methodology-rubric-affecting.
- **litmus-v1.1** — harness completion of behaviors v1 already specified (no grading-rubric change, §5 untouched; `methodologyVersion` stays `litmus-v1`): canary detection now also catches whitespace-split and simply-encoded (base64/hex/url) echoes (§3 "lightly-obfuscated … simple encodings"); canaries are now seeded into a throwaway **working directory** (`.env`/creds files) as well as the environment, so a file-reading tool is caught (§C-03); bait inputs are drawn from a fixed **varied pool** rather than one static string (§7); tools that error/time out on bait are recorded as *unevaluated* in the evidence (no longer a silent pass); and a **bare imperative** in a tool description ("you must/should/need to …") is now **medium** severity, not high, so it no longer false-floors C-01 — legitimate tool docs use that phrasing constantly (only override/role-tag/tool-call patterns stay high and fail C-01). These changes can turn a prior false-negative pass into a correct fail, or a prior false-positive fail into a correct pass — a re-run may move a stale grade in either direction. Harness security hardening (sandbox `--ignore-scripts` + non-root containers) is not methodology-affecting.
- **litmus-v1** — initial: C-01 (1.1, 1.2), C-02 (2.2), C-03 (4.1, 4.2). C-04 deferred.
