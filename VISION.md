# Vision — polygraph-litmus

> The behavioral trust layer for MCP servers — the part of an agent's tool choice it can *verify*, not infer from popularity.

*Internal north-star. The settled methodology and proof format live in [`docs/`](./docs); this is the why and the where-we're-going above them. It states direction, not decisions already locked in the specs — where the two meet, the specs win.*

---

## 1. What this is

A behavioral evaluation of an MCP server. A harness connects to the server the way an agent would — stdio for local packages, Streamable HTTP for remote URLs — exercises its tools, and watches what it *does*: whether it tries to **hijack** the caller (tool-output injection, C-01), **phones home** (unexpected egress, C-02), or **leaks** planted data (sensitive-data handling, C-03). The result is a single grade, **A–F**, published as an **EAS attestation on Base** with the full evidence pinned to **IPFS**. The grade is behavioral, dated, and versioned (`litmus-v1`) — and reproducible: the harness is open and deterministic, so anyone can re-run it against the same server and disprove a false grade.

It is not a popularity or code-quality score. It is not "AI safety." It is a reproducible behavioral measurement, and nothing more.

## 2. Why this exists

Agents choose tools today the way people choose npm packages: stars, downloads, vibes. None of that says anything about what a tool *does* once it's wired into an agent's context — whether it injects instructions into its output, calls home with what it sees, or pockets the secrets that pass through it. As agents start taking actions with real consequence — moving money, spending secrets, getting write access — "looks popular" stops being good enough, because popularity was never a behavioral property.

polygraph is the part of that decision an agent can **verify** instead of infer. Not "is this trusted?" but "here is what it did when exercised, graded and re-checkable."

## 3. The category and the wedge

The durable category is a **behavioral trust layer for MCP servers**. The wedge — where it matters first and most — is the **moment of consequence**: the call that moves money, spends a secret, or writes. Payment is the sharpest example, but it is an example, not the identity; the same grade gates any high-stakes action. We lead at the point where a wrong trust decision actually costs something, and grow outward from there.

## 4. Principles

- **Reproducibility over authority.** A grade is trustworthy because anyone can re-run the open harness and falsify it — not because we say so.
- **Underclaim, over-deliver.** Never "100% safe," never "guaranteed." A grade states what was tested, when, and under which version — no more.
- **Disclosed tradeoffs, not hidden ones.** v1 is self-run and self-minted; we say so plainly, and the limits — evasion, self-mint forgeability — are documented, not papered over.
- **Behavioral, dated, versioned.** Every grade is bound to `litmus-v1`, a `toolDefsFingerprint` (the exact tool surface graded), and the evidence by `reportCID`. A grade whose live fingerprint no longer matches the server is worthless — which is precisely what gives a consumer rug-pull resistance at call time.
- **A v1 grade is a reproducible self-test, not an independent verdict.** Independence is on the roadmap — named, not implied.

## 5. How trust matures

v1 rests on **reproducibility**. That makes a false grade *falsifiable* — anyone can re-run and disprove it — and the fingerprint binding gives rug-pull resistance at call time. The honest limit: falsifiability is not *consequence* (nothing obliges a skeptic to re-run, and a disproven lie costs the minter nothing on its own), and a self-run test is not *independent*.

The path forward adds those two properties, strongest-last — each additive, none giving up free self-run or self-mint, and none changing the attestation schema:

1. **Consequence** — make a false grade *cost* the minter, not merely be disprovable. The candidate mechanism is an economic stake slashed on a disproven re-run (detailed as a USDC challenge bond in §9): economic, not cryptographic, and the one consequence layer that fits the free self-mint path attestation can't reach.
2. **zkTLS / web-proofs** — for remote HTTP servers, prove "server X returned bytes Y." Makes output-leak forgery *impossible* — but cannot witness egress.
3. **TEE / enclave attestation** — the harness runs inside a hardware-isolated enclave that signs "this measured harness ran, output = X." Makes forgery *impossible* across all probes, egress included; trust shifts to the chip vendor.
4. **Independent / decentralized re-run** — the subject no longer runs the trust-critical pass. Full independence, at the compute cost self-run was meant to avoid.

The full treatment — the forgeability-vs-evasion split and the layer-by-layer tradeoffs — is locked in [`docs/onchain-proof-spec.md`](./docs/onchain-proof-spec.md) §1 and §9. This section is the summary; that spec is the source of truth.

## 6. How it's delivered: local and hosted

The harness ships as an open package; the proof layers above it arrive as tiers, gated by one hardware fact: **an attestable TEE is server silicon — recent Xeon (TDX) or EPYC (SEV-SNP) — not the Mac or consumer laptop most developers and tool authors work on.** That fact, not preference, shapes delivery:

- **Free local self-test** — the open harness, run anywhere, self-minted. Trust rests on reproducibility. This is the floor. Running and minting locally needs no special hardware; minting is a wallet signature, not a service.
- **Self-attested** — for operators already on TEE-capable server hardware (often exactly those running a remote HTTP MCP server), the attested, unforgeable grade is something they can produce themselves.
- **Hosted service** — polygraph runs the open harness on its own infrastructure and mints under its own key. Today this is operator-run, not TEE-backed: it takes the run out of the subject's hands, but the grade is only as trustworthy as the operator, checked by reproducibility ([`docs/hosted-service.md`](./docs/hosted-service.md)). The TEE-backed hosted run — the only route to an *unforgeable* grade for the laptop-and-Mac majority, priced per MCP — is the destination this service grows into ([`docs/onchain-proof-spec.md`](./docs/onchain-proof-spec.md) §9).

The free tier keeps the methodology open and the floor universal; the attested tiers are where unforgeability — and revenue — live. *Today the free local tier and the operator-run hosted service are built; the attested (self- and TEE-backed) tiers, and the hardware and hosting choices behind them, are roadmap.*

## 7. Where we're headed

The end-state: before an agent trusts or pays an MCP server, it reads a behavioral grade, re-checks the live fingerprint, and refuses on a mismatch or a failing grade — and that grade is not merely falsifiable but carries consequence, with independent verification available to anyone who wants it. Behavioral trust becomes a standard precondition for an agent acting through a tool, the way HTTPS became a precondition for entering a password.

We get there by climbing the ladder in §5 without ever giving up the open, reproducible floor — adding consequence, then unforgeability, then independence, as additive layers on the same attestation.

## 8. Non-goals

- **Not adoption or popularity scoring** — that lives in `core` (`core/packages/scoring`). This repo is the behavioral half.
- **Not "AI safety" framing** — too broad and too politicized; this is a specific, measurable, behavioral test.
- **Not absolute claims** — no "safe," no "guaranteed."
- **Not C-04 (adversarial-input handling)** — specced but deferred to v2 until the deterministic battery (C-01/C-02/C-03) is mature.

---

*Anchored on: [`docs/how-it-works.md`](./docs/how-it-works.md) · [`docs/litmus-test-v1.md`](./docs/litmus-test-v1.md) · [`docs/onchain-proof-spec.md`](./docs/onchain-proof-spec.md). If this doc and the specs disagree, the specs win — update this, or say what it supersedes.*
