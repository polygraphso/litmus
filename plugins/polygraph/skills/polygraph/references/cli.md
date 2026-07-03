# Polygraph CLI & MCP reference

Polygraph ships two command-line surfaces:

| Package | Bin | Purpose |
|---------|-----|---------|
| **`polygraphso`** | `polygraphso` | Thin, sub-second **lookup** client for published grades. Published on npm. |
| **`@polygraphso/litmus`** | `polygraphso-litmus`, `polygraphso-litmus-mcp` | The full open **harness** — runs the probes and grades a server; also an embeddable MCP server. |

Server refs are always **registry-prefixed**: `<registry>/<owner>/<name>` — e.g.
`npm/@modelcontextprotocol/server-filesystem`, `pypi/mcp-server-git`,
`github/anthropic/mcp-server-foo`. The prefix disambiguates names that exist on multiple
registries. The harness also accepts a raw `https://…/mcp` URL or a local path.

---

## `polygraphso` — look up a grade

```bash
npx polygraphso@<version> check npm/@modelcontextprotocol/server-filesystem   # sub-second lookup
npm i -g polygraphso                                                          # or install globally

polygraphso check <registry>/<owner>/<name>     # latest published grade
polygraphso list [--json]                       # every graded server + its grade
polygraphso --version
polygraphso --help
```

`check` runs the `polygraphso` **lookup** CLI — it reads a published grade and does **not** install
or execute the target server. `npx` still fetches and runs our CLI, so this is a lookup, not a
"no-install" trust check; **pin the version** (`polygraphso@<version>`) in any automated context.

Grades are live. Example output (the list rows are **illustrative** — a grade is point-in-time
evidence, so the live set at `polygraphso list` / polygraph.so is the source of truth):

```
$ polygraphso check npm/@modelcontextprotocol/server-filesystem
→ polygraph: A · litmus-v10 · 2026-06-26
→ details → polygraph.so/#checks

$ polygraphso list                              # every graded server + its grade
npm/@modelcontextprotocol/server-filesystem    A
npm/@scope/example-search-mcp                   D
npm/@scope/example-browser-mcp                  F

$ polygraphso list --json | jq -r '.servers[] | "\(.polygraph)  \(.server_ref)"'
A  npm/@modelcontextprotocol/server-filesystem
…
```

A tracked-but-ungraded server reports `not available yet` with a
`polygraph.so/notify?for=<ref>` link; its grade lands as the litmus harness covers more of the
ecosystem.

Config: `POLYGRAPH_API_URL` overrides the lookup endpoint (useful for local testing). HTTPS is
enforced (plain `http` only for `localhost`), so it isn't a MITM vector — but the residual risk is
endpoint **trust**: for any execution or payment decision, point it only at the official
`polygraph.so` endpoint or a mirror you control. An attacker-supplied endpoint can return fabricated
grades; never accept one from untrusted config.

---

## `@polygraphso/litmus` — run the harness

```bash
npm i -g @polygraphso/litmus
# or, no install:
npx -y -p @polygraphso/litmus polygraphso-litmus litmus <ref>
```

### Commands

```bash
polygraphso-litmus litmus <ref | https-url | local-path>                              # grade a server end-to-end
polygraphso-litmus check  <ref>                                                       # look up a published grade
polygraphso-litmus list                                                               # list published grades
polygraphso-litmus ci [--server <ref>] [--skill <dir>] [--min-grade <A|B|C|D>] [--strict]   # gate a build on D/F (servers + skills)
polygraphso-litmus --version | --help
```

The `ci` command gates a build on the grades of a repo's MCP servers and skills — see [`ci-gate.md`](ci-gate.md).

Reproducibility is the teeth: re-run `litmus` against a server that already carries a grade
and, if your result disagrees, that's a falsification anchored to the same tool-surface
fingerprint.

### Flags (`litmus`)

| Flag | Effect |
|------|--------|
| `--json` | Emit the full canonical `EvidenceBundle` instead of the human summary. |
| `--bearer <token>` | Bearer auth for an HTTP target (or set `LITMUS_BEARER`). Sent as `Authorization: Bearer` to the target — trusted, pinned remote only; scoped and short-lived; never on an auto-discovered or untrusted target. |
| `--header "Key: Value"` | Add a custom request header (repeatable). |
| `--allow-state-changing` | Permit calls to state-mutating tools during dynamic probes. |

### Environment

| Var | Effect |
|-----|--------|
| `POLYGRAPH_API_URL` | Set to `https://polygraph.so` to pin the evidence bundle and get a publish/mint hand-off URL. Unset = fully offline run. HTTPS enforced; point only at an endpoint you trust for execution decisions. |
| `LITMUS_BEARER` | Bearer token for HTTP auth. Sent to the target — trusted pinned remote only; scoped and short-lived. |
| `LITMUS_STDIO_ISOLATION` | Set to `docker` to **require** Docker isolation for stdio targets (fail-closed if Docker is unavailable). |

### Requirements & exit codes

- **Node ≥ 18.**
- **Docker optional** — without it the egress probe (C-02) is skipped and the grade is capped
  at **B**. A **remote/HTTP target also caps at B**, since it can't be sandboxed for egress —
  that's a property of the measurement, not a knock against the server. With
  `LITMUS_STDIO_ISOLATION=docker`, isolation is mandatory.
- **Exit codes:** non-zero on a failing grade (**D/F**), zero on a passing grade (**A/B**) —
  drop `litmus` into CI to gate a dependency on its behavioral grade.

### Human output

```
→ litmus · npm/@modelcontextprotocol/server-filesystem
→ version 0.1.0
→ C-01 pass · C-02 pass · C-03 pass · C-04 pass
→ fingerprint 0x1a2b3c4d…5e6f7890
→ grade: A
   All four categories passed. No injection, no unexpected egress, no data leak.
```

On failure the summary lists the top HIGH-severity findings (tool name, finding kind,
snippet). The `--json` bundle carries everything (see
[`methodology.md`](methodology.md#the-evidence-bundle)).

---

## MCP server (`polygraphso-litmus-mcp`)

Embed polygraph in Claude, Cursor, or any MCP client so your agent can check, grade, and
verify servers inline. Tools:

- **`check_server`** — sub-second read of a server's published grade on polygraph.so; the
  default first move before recommending or installing a server.
- **`list_servers`** — every server with a published grade, A first.
- **`request_grade`** — queue an ungraded server for grading (free, best-effort; read the
  result later with `check_server`).
- **`run_litmus`** — grade a server and return grade, per-category findings, fingerprint, and
  (when `POLYGRAPH_API_URL` is set) a publish hand-off.
- **`verify_attestation`** — read a server's onchain grade and return the attested grade,
  fingerprint, report CID, and revocation/network status. Recompute the live fingerprint and
  require it to equal the attested one before trusting the server.

```json
{
  "mcpServers": {
    "polygraph": {
      "command": "npx",
      "args": ["-y", "-p", "@polygraphso/litmus", "polygraphso-litmus-mcp"],
      "env": { "POLYGRAPH_API_URL": "https://polygraph.so" }
    }
  }
}
```

See the "Verify before you trust" section of [`../SKILL.md`](../SKILL.md) for the
verify-then-execute pattern.

---

## Programmatic use

```ts
import { runLitmus, gateDecision, liveFingerprint, readAttestation, PAYMENT_PASSING } from "@polygraphso/litmus";

const bundle = await runLitmus("npm/@scope/server");   // → EvidenceBundle { grade, categories, fingerprint, … }

const attestation = await readAttestation("npm/@scope/server");  // binds to our EAS schema + a fixed Base RPC (fail-closed)
const live = await liveFingerprint("npm/@scope/server");

// Read-only / low-value: grade A/B + live fingerprint match is enough.
const ok = gateDecision(attestation, live).action === "pay";

// Signed actions / payments — raise the bar. A self-minted grade is forgeable, so:
const payDecision = gateDecision(attestation, live, PAYMENT_PASSING, undefined, {
  requireEgressVerified: true,                       // exclude remote/no-sandbox B (egress never observed)
  allowedAttesters: new Set(["0x…"]),                // trust a known signer…
  acceptedMethodologyVersions: new Set(["litmus-v10"]),
});                                                  // …or, strongest: re-run runLitmus() yourself and compare.
```
