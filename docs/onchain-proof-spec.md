# Onchain Proof Specification — Polygraph Litmus

**Status: specification** · Companions: [`litmus-test-v1.md`](./litmus-test-v1.md) (what is measured), [`technical-design.md`](./technical-design.md) (how it's built)

This document defines the **proof format**: the evidence bundle, the IPFS layer, the EAS attestation schema, the addresses, and — most importantly — the **verification protocol** anyone can run to confirm (or refute) a grade. It is the single source of truth for the schema and bundle shapes; the other docs reference it.

> ⚠️ Several SDK/version/address facts below are flagged **[verify]** — confirm them at install time before relying on them (see §8). Contract addresses given are OP-Stack predeploys and are stable; the npm package versions are not.

---

## 1. Trust model (read first)

v1 is **self-run, self-minted**: the subject runs the open-source litmus harness on itself and signs its own attestation. Whether that is trustworthy does **not** hinge on who runs or who mints it — it hinges on two separable properties:

- **Forgeability** — can the minter fake the result? (fixable; see below)
- **Evasion** — can the *server* detect it's being tested and behave, then misbehave in production? (a fundamental limit of any known test, addressed in [`litmus-test-v1.md`](./litmus-test-v1.md) §7)

This section is about forgeability. Plain self-mint — the literal MVP — is the one variant that *is* forgeable: running and signing it yourself, you can patch the harness, hand-write a clean bundle, and mint a passing attestation. The fix is to add an **unforgeability** or **skin-in-the-game** layer — without giving up self-run or self-mint:

| Layer | Makes forgery… | Covers | Works for | Catch |
|---|---|---|---|---|
| **Reproducibility only** — ✅ **chosen MVP layer** | *falsifiable* — anyone can re-run and disprove | all probes | stdio + remote | no *consequence* for a disproven lie; nobody is obliged to re-run |
| **USDC challenge bond** (roadmap) | *unprofitable* — stake slashed on a disproven re-run | all probes | stdio + remote | crypto-economic, not cryptographic; security scales with bond size + challengers |
| **zkTLS / web-proofs** (Reclaim, vlayer, Primus) | *impossible* (responses) — proves "server X returned bytes Y" | C-01, C-03 output-leak | **remote HTTP only** | can't witness egress (the server's own outbound); no stdio |
| **TEE / enclave attestation** (Nitro, TDX, SGX, SEV) | *impossible* — hardware signs "this measured harness ran, output = X" | all probes | stdio + remote | needs TEE hardware; trust shifts to the chip vendor; heaviest build |
| **Independent / decentralized re-run** (the lab model) | *impossible* — the subject doesn't run the trust-critical pass | all probes | stdio + remote | reintroduces the compute cost self-run was meant to avoid |

**Regardless of layer**, the attestation binds the grade to a **`toolDefsFingerprint`** (the exact tool surface graded) and references the full evidence by **`reportCID`** (IPFS). So even reproducibility-only gives **rug-pull resistance** — *provided the consumer checks the live fingerprint against the attested one at call time* (§7). A grade whose fingerprint no longer matches the live server is worthless.

**Chosen for the MVP:** **reproducibility only.** It preserves free self-run + self-mint and makes a false grade *falsifiable* — anyone can re-run the open harness and disprove it — while the fingerprint binding (below) gives rug-pull resistance at call time. The honest trade-off: it buys *falsifiability*, not *consequence* — nothing obliges a skeptic to re-run, and a disproven lie costs the minter nothing. The upgrades that add consequence or independence — a staked **USDC challenge bond**, **zkTLS** web-proofs for remote servers, **TEE** attestation, an **independent re-run** — are the roadmap (§9).

---

## 2. Evidence bundle (the off-chain artifact)

A single canonical JSON document, produced by the harness, pinned to IPFS. **Canonicalization rules**: object keys sorted lexicographically (recursively); arrays in a fixed, documented order (categories by code, probes by ID); ISO-8601 UTC timestamps; raw tool-definition bytes preserved (so hidden-Unicode tampering changes the fingerprint — see [`litmus-test-v1.md`](./litmus-test-v1.md) §6).

```jsonc
{
  "schemaVersion": "1.0.0",                 // bundle-format version (this doc)
  "methodologyVersion": "litmus-v1",        // the test methodology
  "serverRef": "npm/@scope/name",           // canonical, versionless (serverKey)
  "resolvedVersion": "0.4.2",               // exact version actually run
  "target": { "kind": "stdio", "command": "npx -y …", "url": null },
  "toolDefsFingerprint": "0x<64 hex>",      // sha256 of the canonical tool surface → bytes32
  "toolDefs": [ /* the canonicalized {name, description, inputSchema} that was hashed */ ],
  "ranAt": "2026-06-02T15:04:05Z",
  "harness": {
    "package": "@polygraph/probes",
    "version": "0.1.0",
    "node": "22.x",
    "dockerAvailable": true                 // governs C-02 / probe 4.2 applicability
  },
  "categories": [
    { "code": "C-01", "status": "pass|fail",
      "probes": [
        { "id": "1.1", "status": "pass|fail", "findings": [ /* {kind,severity,match,offset,tool} */ ] },
        { "id": "1.2", "status": "pass|fail", "findings": [ … ] }
      ] },
    { "code": "C-02", "status": "pass|fail|skipped", "reason": "remote target | no sandbox | null",
      "probes": [ { "id": "2.2", "status": "…", "findings": [ /* {host,port,firstBytes} */ ] } ] },
    { "code": "C-03", "status": "pass|fail",
      "probes": [
        { "id": "4.1", "status": "…", "findings": [ … ] },
        { "id": "4.2", "status": "pass|fail|partial", "reason": "no egress capture | null", "findings": [ … ] }
      ] }
  ],
  "grade": "A",                             // A–F, per litmus-test-v1 §5
  "gradeRationale": "All categories passed. Egress verified clean.",
  "disclaimer": "Self-run, self-minted under litmus-v1. Independence traded for cost. Re-run the open harness to verify."
}
```

The bundle is content-addressed: its CID *is* its hash, so the `reportCID` in the attestation pins this exact document.

---

## 3. EAS attestation (the on-chain artifact)

We attest with the [Ethereum Attestation Service](https://attest.org) on Base. One schema, registered once per network; each litmus result is one attestation referencing the bundle CID.

### Schema
```
string  serverRef,
bytes32 toolDefsFingerprint,
uint8   gradeC01,            // 0=pass, 1=fail, 2=skipped
uint8   gradeC02,
uint8   gradeC03,
string  overallGrade,        // "A".."F"
string  reportCID,           // IPFS CID of the evidence bundle (§2)
string  methodologyVersion,  // "litmus-v1"
uint64  ranAt                // unix seconds
```
Design notes: `serverRef` is a `string` so attestations are **discoverable by ref**; per-category verdicts are `uint8` (cheap, queryable); the human grade is a short string; the heavy evidence stays off-chain, pinned by `reportCID`. Attestations are **revocable** (a server that rug-pulls can have a stale attestation revoked).

- **`recipient`**: the subject's address (the minter), or `ZeroAddress` if not bound to a recipient. **[decide at build]** — recommend recipient = minter so a wallet can list "my polygraph proofs."
- **`expirationTime`**: `NO_EXPIRATION` (the fingerprint, not a clock, is what expires the claim).
- **`schemaUID`**: produced at registration (§5); stored in `web/lib/eas.ts`, switched by network.

### Encoding (EAS SDK, ethers v6)
```ts
const enc = new SchemaEncoder(
  "string serverRef,bytes32 toolDefsFingerprint,uint8 gradeC01,uint8 gradeC02,uint8 gradeC03,string overallGrade,string reportCID,string methodologyVersion,uint64 ranAt"
);
const data = enc.encodeData([
  { name: "serverRef",          value: ref,         type: "string"  },
  { name: "toolDefsFingerprint",value: fingerprint, type: "bytes32" },
  { name: "gradeC01",           value: c01,         type: "uint8"   },
  { name: "gradeC02",           value: c02,         type: "uint8"   },
  { name: "gradeC03",           value: c03,         type: "uint8"   },
  { name: "overallGrade",       value: grade,       type: "string"  },
  { name: "reportCID",          value: cid,         type: "string"  },
  { name: "methodologyVersion", value: "litmus-v1", type: "string"  },
  { name: "ranAt",              value: ranAtUnix,   type: "uint64"  },
]);
// eas.connect(signer); await (await eas.attest({ schema: SCHEMA_UID, data: { recipient, expirationTime: NO_EXPIRATION, revocable: true, data } })).wait();
```

---

## 4. Addresses, networks, env

EAS contracts are **OP-Stack predeploys — identical on Base and Base Sepolia.**

| | Base **Sepolia** (build) | Base **mainnet** |
|---|---|---|
| `chainId` | `84532` | `8453` |
| RPC | `https://sepolia.base.org` | `https://mainnet.base.org` |
| EAS | `0x4200000000000000000000000000000000000021` | `0x4200000000000000000000000000000000000021` |
| SchemaRegistry | `0x4200000000000000000000000000000000000020` | `0x4200000000000000000000000000000000000020` |
| EAS explorer | `base-sepolia.easscan.org` | `base.easscan.org` |
| schema UID | from Sepolia registration | from mainnet registration |

**Single switch.** `NEXT_PUBLIC_POLYGRAPH_NETWORK = base-sepolia | base` selects the row. All network-dependent constants live in **`web/lib/eas.ts`** (web can't import workspace packages) and a mirror in the probes/agent packages.

**Faucet (Sepolia):** Base Sepolia ETH via the Coinbase/Base faucet — the minter needs gas to register the schema and attest.

---

## 5. Schema registration (one-time, per network)

Two equivalent paths — pick whichever is faster on the day:

- **Script:** `packages/probes/src/scripts/register-schema.ts` →
  `new SchemaRegistry("0x4200…0020").connect(signer).register({ schema: SCHEMA_STRING, resolverAddress: ZeroAddress, revocable: true })` → prints the schema UID.
- **UI (zero-code):** `base-sepolia.easscan.org/schema/create` (and `base.easscan.org` for mainnet), paste the schema string, copy the UID.

The resulting UID is a **constant** baked into `web/lib/eas.ts` per network. Register once on each network you demo.

---

## 6. IPFS pinning

- **Primary:** Pinata, pinned **server-side** via `web/app/api/pin/route.ts`. The CLI POSTs the bundle JSON to `polygraph.so/api/pin` (or `POLYGRAPH_API_URL` locally); the route holds `PINATA_JWT` server-only and returns `{ cid }`. Keeping the JWT off the client matches the repo's "all secrets server-side" posture (`.env.example`, `web/app/api/cli/check/route.ts`).
- **Fallback:** if Pinata is unconfigured/down, the route stores the bundle in Supabase (`behavioral_grades.report_json`) and returns a `polygraph.so/report/<id>` URL used in place of a CID — the demo still shows "evidence published + referenced onchain," noted as the hosted fallback.
- **[verify]** Pinata SDK method names shift across versions (`upload.public.json()` vs legacy `pinJSONToIPFS`) — confirm against the installed SDK.

---

## 7. Verification protocol (how anyone confirms a grade)

This is the payoff of the whole design — the steps a skeptic, counterparty, or the agent-gate performs:

1. **Read the attestation.** From `serverRef` (or a known UID), read the EAS attestation on Base → `{ toolDefsFingerprint, per-category verdicts, overallGrade, reportCID, methodologyVersion, ranAt }`.
2. **Fetch the evidence.** Resolve `reportCID` from any IPFS gateway → the bundle (§2). Confirm the CID matches the bytes (content-addressing).
3. **Re-run the harness.** Run `litmus-v1` against the same `serverRef@resolvedVersion`.
4. **Compare.** (a) Re-computed `toolDefsFingerprint` equals the attested one → the tool surface is unchanged (no rug pull). (b) Re-derived grade equals `overallGrade`. A mismatch on either **refutes** the attestation.

**A trust gradient, not all-or-nothing.** A consumer picks how much to verify against the value at stake:

- **Cheap (call-time minimum):** read the attestation on-chain, fetch the live server's tool defs, **recompute the fingerprint and require it to equal the attested one**, then trust the on-chain grade. This costs one `listTools()` + a hash and is what stops a rug pull — a passing attestation that points at a tool surface the server no longer serves. Skip it and rug-pull resistance is purely theoretical.
- **Full (high-value):** additionally re-run `litmus-v1` and re-derive the grade (steps 3–4).

The **agent payment-gate** ([`technical-design.md`](./technical-design.md) §6) must perform at least the cheap check on every gated call, and may escalate to a full re-run for large payments. Discovery of the UID from a `serverRef` is DB-assisted (`/api/attestations`), but the **fingerprint comparison is done against the live server and the grade is read on-chain**, so the trust-critical bits are never taken from polygraph's database.

---

## 8. Verify-at-install checklist

Pin and confirm before relying on any of these:

- Exact current versions: `@ethereum-attestation-service/eas-sdk` (uses **ethers v6**), `wagmi` / `viem` / `@tanstack/react-query`, Pinata SDK. (`npm view <pkg> version`.)
- EAS SDK: confirm `NO_EXPIRATION` export and that `(await eas.attest(...)).wait()` returns the attestation UID in the installed version.
- Wallet connector: `wagmi` v2 + `viem` against React 19.2 / Next 16 (`useAccount` / `useConnect` / `useWalletClient`); the viem→ethers signer adapter (`web/lib/ethers-adapter.ts`) feeds the ethers-based `eas.attest`.
- Pinata: upload method name (see §6).
- **Base mainnet USDC address** at `circle.com/usdc/addresses` before the mainnet flip.
- Next 16 route/handler specifics via `web/node_modules/next/dist/docs/` (the repo warns this Next diverges from training data — `web/AGENTS.md`).

---

## 9. Roadmap — adding consequence and independence

v1 stops at **reproducibility** (§1): a false grade is *falsifiable* but carries no *consequence*, and the test is self-run, not independent. The upgrades that close those gaps, strongest-last:

- **USDC challenge bond** — the minter stakes USDC behind the grade; a disproven re-run slashes the stake, making a lie *unprofitable*. Preserves free self-run + self-mint and is a pure stablecoin mechanic. (An earlier arbiter-free design — deterministic on-chain fraud proofs plus a permissionless commit-reveal re-run quorum — was prototyped and removed from v1; it remains the reference for this layer.)
- **zkTLS / web-proofs** (Reclaim, vlayer, Primus) — for **remote HTTP** servers, prove "server X returned bytes Y," making C-01 / output-leak forgery *impossible* (cannot witness egress).
- **TEE / enclave attestation** — hardware signs "this measured harness ran, output = X" for all probes; trust shifts to the chip vendor.
- **Independent / decentralized re-run** (the lab model) — the subject no longer runs the trust-critical pass; full independence at the cost self-run was meant to avoid.

Each is additive — none requires giving up self-run or self-mint, and the attestation schema (§3) is unchanged.
