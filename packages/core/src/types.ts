/**
 * Shared contract types for the litmus MVP. Web3-free.
 *
 * In-memory / evidence-bundle types are camelCase to match the canonical
 * bundle JSON in `docs/onchain-proof-spec.md` §2. (Postgres row types added
 * later for the discovery DB will be snake_case, mirroring the columns.)
 */

/** Package registries a server ref can name. */
export type Registry = "npm" | "pypi" | "github";

/** The methodology this build implements; embedded in every bundle + attestation.
 *  v17 hardens remote (Streamable HTTP) grading, closing three gaps disclosed as
 *  residual limits. (1) HONEST C-03: canaries can only be planted into a local
 *  stdio target's environment and working directory, so on a remote target
 *  nothing is planted. Probe 4.1 now returns skipped with a plain reason instead
 *  of an unearned pass, and the C-03 category resolves to skipped (never pass)
 *  whenever nothing was planted and no leak turned up; a real leak still fails
 *  C-03 to F, and a skipped C-03 still only ever caps the grade at B, alongside
 *  the existing C-02 skip. This is the one pass/fail-semantics change, so it
 *  alone forces the version bump. (2) PRESENTED IDENTITY: the harness no longer
 *  announces itself with a fixed name and version in the MCP initialize
 *  handshake, which made evasion nearly free for a remote operator. It instead
 *  presents a plausible current agent-client identity, chosen deterministically
 *  from a small pool (or from an operator override, never from a random or
 *  wall-clock source, so a re-run reproduces the same pick), and records exactly
 *  which one it presented in the evidence bundle. (3) SURFACE CONSISTENCY: for a
 *  remote target only, after the grade is computed the harness opens one more
 *  independent connection, re-enumerates the tool surface, and compares its
 *  fingerprint to the graded one. A mismatch is recorded as an advisory
 *  disclosure finding, never a grade change; catching an actual rug pull between
 *  grading and use is the agent gate's live-fingerprint recheck's job, not this
 *  grade's.
 *  v16 hardens the grade against the "everything is A" clustering and deepens coverage.
 *  (1) COVERAGE CAP: the dynamic probes skip actively calling state-changing tools on
 *  the HOST path (tool-safety.ts) so the harness can't move money or mutate real state —
 *  which left the *most dangerous* surface graded on the static scan alone and still
 *  reaching A. Under Docker isolation, though, the target runs `--network none` in a
 *  throwaway sandbox, so exercising those tools is safe: the harness does it by default,
 *  and a write-capable server earns A on the same terms as a read-only one (write access
 *  is not itself a demerit). The cap fires only where exercising WOULD hit a live backend
 *  — the host path (`--unsafe-host-exec`) or a remote https target: there a high-risk tool
 *  left unexercised caps at B (usable, not payment-eligible), and an unambiguously
 *  destructive/value-moving tool unexercised AND a category (typically egress) unverified
 *  compounds to C (refused by default). `--allow-state-changing` clears the cap anywhere.
 *  (2) TOOL
 *  POISONING: C-01 probe 1.1 flags agent-directed instructions hidden in a tool's
 *  advertised surface — a concealment directive ("do not tell the user"), an imperative
 *  to read a known secret file (`~/.ssh/id_rsa`, `.aws/credentials`), or an
 *  agent-directed hook paired with an exfil sink — the documented MCP tool-poisoning
 *  class the override-framing patterns missed. (3) INDIRECT/PASSTHROUGH INJECTION: a new
 *  C-01 probe 1.4 feeds the harness's OWN injection-laced external content into
 *  content-fetching tools (a seeded file it reads, or a loopback URL it retrieves on the
 *  host path) and grades the relay — a tool that passes third-party content through
 *  VERBATIM is disclosed as an indirect-injection conduit (not failed: faithful relay is
 *  legitimate and the agent is expected to distrust tool output), while a tool that
 *  AMPLIFIES it — emitting injection NOT present in our payload — fails C-01, the same
 *  "only server-generated injection fails" rule 1.2/1.3 apply to other channels.
 *  (4) WIDER CORPORA: more jailbreak framings (tool-shadowing, a fabricated tool-result
 *  frame, a base64-wrapped directive, a javascript: link), two more malformed shapes
 *  (huge-number, lone-surrogate), more runtime crash signatures (Elixir/C++/Swift/Kotlin),
 *  and provider-shaped canaries (AWS/GitHub/JWT). v16 can move a verdict DOWN (A→B/C) and
 *  adds a failing probe, so — unlike the v2–v14 false-positive fixes — it is NOT
 *  monotonic; older attestations stay valid only because the version is a string field
 *  the agent gate does not branch on.
 *  v11 refines C-02 probe 2.2 (egress overreach): an undeclared egress host that
 *  the server's own tool surface identifies as its advertised upstream — an API
 *  wrapper reaching the API it wraps — is recorded as an informational
 *  `egress-inferred` finding instead of failing C-02. Egress to a host with no
 *  relationship to the advertised surface still fails. The change only ever moves
 *  a verdict D → higher (monotonic), so v1–v10 attestations stay valid.
 *  v8 further cuts C-01/C-04 injection false positives that flipped honest servers
 *  to D/F: the tool-call-JSON signature flags only the execute shapes `"tool_call"`/
 *  `"function_call"`, not the honest field names `"tool_name"`/`"function"` (a tool
 *  listing or contract ABI); the `system:` role label no longer trips on an INDENTED
 *  config/YAML key (`\n  system: gpt-4`); and a benign base64 raster `data:image/*`
 *  URI is no longer read as a script-bearing `data:` URI. Each can move a verdict,
 *  so it is a version bump.
 *  v7 narrows C-01 instruction-mimicry to cut false positives that flipped honest
 *  servers to F: the static scan (probe 1.1) reads a tool's JSON-Schema text VALUES
 *  (descriptions, enums) instead of its stringified structure, so a parameter named
 *  `function`/`system` no longer reads as injected tool-call JSON; the `system:`
 *  role label is anchored to line start ("design system:" prose no longer trips it);
 *  and the `<user>`/`<tool>` role tags — common in honest docs — are dropped, keeping
 *  `<system>`/`<assistant>`. Each can move a verdict, so it is a version bump.
 *  v5 hardens the probes (same A–F rubric): wider deterministic bait/jailbreak/
 *  malformed batteries (so a defeat device can't benign-out a small fixed pool),
 *  a new C-01 probe 1.3 (second-order injection — a tool's output weaponized as
 *  another tool's input), port-aware C-02 egress (a declared host reached on an
 *  UNDECLARED port is overreach), and a widened C-02 probe 2.1 (a read-only claim
 *  contradicted by a PARAMETER or DESCRIPTION, not just the name). Each can move a
 *  verdict, so it is a version bump. v4 makes C-04 (adversarial input handling) a
 *  graded category: a server that crashes/hangs, leaks internals (a stack trace),
 *  or amplifies hostile input on malformed/jailbreak inputs fails C-04 (capped at
 *  D). v3 reframed C-02 probe 2.2 from default-deny to OVERREACH (egress to a
 *  declared/baseline host is permitted; only egress beyond that union fails — "A"
 *  means "no overreach", not "no network"); v2 added probe 2.1. A pass/fail-
 *  semantics change → version bumps per litmus-test §8. The version is a string
 *  field on the attestation, so v1–v8 attestations coexist and the agent gate does
 *  not branch on it. v6 widens the default tool-safety skip set: a tool that claims
 *  read-only but evidences mutation is no longer actively exercised, which can
 *  change which tools are probed (hence the grade) on such servers. v13 recalibrates
 *  C-01: a zero-width code point is graded MEDIUM (a benign documentation artifact on
 *  its own) rather than an automatic HIGH floor, and the injection scanners now strip
 *  invisible chars before matching so a zero-width-split keyword still fails HIGH — plus
 *  weak `<user>`/`<tool>` role tags must wrap prose, `<system|…>`-style pipe placeholders
 *  and non-mediatype `data:` descriptions no longer flag, and "new/updated system
 *  prompt" floors only as a colon-introduced directive. Net effect: fewer C-01 false
 *  floors, same true-positive detection. v14 fixes a C-04 probe 3.2 false positive:
 *  a server that safely REJECTS an injected jailbreak and quotes it back inside its
 *  own error frame (`Invalid label "…"`, `Error: … not found: …`) — including
 *  char-stripped or truncated echoes the complete-echo mask couldn't catch — is no
 *  longer mis-flagged as amplification. Only echoes of OUR injected payloads inside a
 *  rejection frame are neutralized, so server-GENERATED injection (and compliant
 *  echo-then-splice) still fails; some safe-rejecting servers move D→A. v15 fixes a
 *  C-02 probe 2.2 false positive: the egress baseline now includes public
 *  package-registry infrastructure (pypi.org, files.pythonhosted.org,
 *  registry.npmjs.org), so a framework/tooling update-check — chiefly FastMCP's
 *  default startup ping to pypi.org — is no longer scored as the server's own
 *  overreach. The cloud instance-metadata endpoint is deliberately NOT allowlisted
 *  (a real SSRF/credential target); only registry hosts move D→A. */
export const METHODOLOGY_VERSION = "litmus-v17" as const;
/** Evidence-bundle format version (owned by onchain-proof-spec §2).
 *  1.10.0 adds the optional `harness.presentedClientInfo` field (the client
 *  identity presented in the MCP initialize handshake, litmus-v17) and the
 *  optional top-level `surfaceConsistency` field plus the `surface-drift`
 *  finding kind (a same-session tool-surface drift advisory for a remote
 *  target, litmus-v17); both are present only when applicable, so older
 *  bundles remain valid.
 *  1.9.0 adds the C-01 probe id `1.4` (indirect/passthrough injection, litmus-v16)
 *  and the `indirect-injection` finding kind (a tool that relays harness-planted
 *  external content verbatim — disclosure, not a fail);
 *  1.8.0 adds the optional `coverage` field (the high-risk tools left behaviorally
 *  unexercised, so the litmus-v16 coverage cap is auditable from the bundle alone;
 *  present only when non-empty);
 *  1.7.0 adds the `egress-inferred` finding kind (C-02 probe 2.2 records an
 *  undeclared egress host it inferred to be the server's own advertised upstream;
 *  informational, not a fail);
 *  1.6.0 adds the optional `context` evidence window on text-scan findings
 *  (instruction-mimicry / markdown-trick / invisible-unicode);
 *  1.5.0 adds the optional `selfReportedVersion` field (the server's
 *  self-asserted `serverInfo.version`, descriptive metadata only);
 *  1.4.0 adds the C-01 probe id `1.3` (second-order injection, litmus-v5);
 *  1.3.0 adds the optional C-04 category and the `internals-leak`/`crash` finding
 *  kinds (litmus-v4); 1.2.0 adds the optional `target.declaredEgress` field and
 *  the `egress-allowed` finding kind (litmus-v3); 1.1.0 adds
 *  `harness.stdioIsolation`; older remain valid. */
export const BUNDLE_SCHEMA_VERSION = "1.10.0" as const;

// ── Categories & probes (litmus-test-v1 §2) ──────────────────────────────────

export type CategoryCode = "C-01" | "C-02" | "C-03" | "C-04";

/**
 * Plain-English label + one-line description for each probe category, so CLI and
 * MCP output is legible without knowing the probe IDs. The single source of these
 * strings — both renderers and the MCP `run_litmus` summary read from here.
 */
export const CATEGORY_META: Record<CategoryCode, { label: string; description: string }> = {
  "C-01": { label: "tool-output injection", description: "whether it tries to hijack the caller through tool output" },
  "C-02": { label: "permission / egress overreach", description: "whether it reaches the network beyond what it declares" },
  "C-03": { label: "sensitive-data handling", description: "whether it leaks planted secrets it was handed" },
  "C-04": { label: "adversarial-input handling", description: "whether it stays stable on malformed or hostile input" },
};

/** Probe IDs carry their family number (1=injection, 2=permission,
 *  3=adversarial-input, 4=sensitive). 1.3 (second-order injection) added in v5;
 *  1.4 (indirect/passthrough injection via harness-controlled external content)
 *  added in v16. */
export type ProbeId = "1.1" | "1.2" | "1.3" | "1.4" | "2.1" | "2.2" | "3.1" | "3.2" | "4.1" | "4.2";

export type CategoryStatus = "pass" | "fail" | "skipped";
export type ProbeStatus = "pass" | "fail" | "skipped" | "partial";

export type LitmusGrade = "A" | "B" | "C" | "D" | "F";
export type Severity = "low" | "medium" | "high";

/** uint8 encoding for per-category verdicts on the attestation (onchain-proof-spec §5). */
export const CATEGORY_STATUS_UINT8: Record<CategoryStatus, number> = {
  pass: 0,
  fail: 1,
  skipped: 2,
};

// ── Findings & probe results (technical-design §3) ───────────────────────────

export type FindingKind =
  | "invisible-unicode"
  | "instruction-mimicry"
  | "tool-poisoning" // agent-directed instruction hidden in a tool's surface (C-01, litmus-v16)
  | "indirect-injection" // a tool relays harness-planted external content verbatim (C-01 probe 1.4, litmus-v16) — disclosure, not a fail
  | "markdown-trick"
  | "canary"
  | "egress"
  | "egress-allowed"
  | "egress-inferred"
  | "permission-mislabel"
  // Session-level advisory, not a probe finding (litmus-v17):
  | "surface-drift" // a remote target served a different tool surface on a same-session recheck than it was graded on; disclosure, never a grade change
  // C-04 (adversarial input handling, litmus-v4):
  | "internals-leak" // an uncaught stack trace / crash banner surfaced in output
  | "crash" // the server stopped responding after a malformed/oversized input
  // Skill litmus (litmus-skill-v1) — additive; MCP grading never emits these:
  | "exfil-instruction" // body/bundle instructs sending secrets to a sink
  | "dangerous-command" // a bundled executable runs a dangerous/obfuscated command
  | "over-broad-trigger"; // a frontmatter trigger that claims to fire on everything

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** The matched substring (or a hex dump, for invisible characters). */
  match: string;
  /** Byte offset where the match starts, when applicable. */
  offset?: number;
  /** A small, hard-capped, code-point-safe window of the scanned text around the
   *  match — lets a reader classify the finding (genuine injection vs. benign content
   *  that merely contains the pattern) from the bundle alone. Populated only for the
   *  low-disclosure C-01/C-04 text scans (instruction-mimicry, markdown-trick,
   *  invisible-unicode); omitted for canary/internals-leak (privacy). */
  context?: string;
  /** Offending tool name, when the finding is tied to one. */
  tool?: string;
  /** Offending bundled file (relative path), for skill findings tied to a file. */
  file?: string;
  // egress findings (C-02 / probe 4.2):
  host?: string;
  port?: number;
  firstBytes?: string;
}

export interface ProbeResult {
  id: ProbeId;
  status: ProbeStatus;
  findings: Finding[];
  /** Skip/partial reason, when status is `skipped` or `partial`. */
  reason?: string | null;
}

export interface CategoryResult {
  code: CategoryCode;
  status: CategoryStatus;
  reason?: string | null;
  probes: ProbeResult[];
}

// ── Target & tool surface ────────────────────────────────────────────────────

export type TargetKind = "stdio" | "http";

export interface TargetDescriptor {
  kind: TargetKind;
  /** stdio: the launched command (e.g. `npx -y <pkg>`). */
  command?: string | null;
  /** http: the remote MCP URL. */
  url?: string | null;
  /** The server's declared egress host patterns (`polygraph.egress`, C-02
   *  litmus-v3). Present only when non-empty. Disclosure, not exoneration. */
  declaredEgress?: string[];
}

/** The canonicalized fields of a tool that the fingerprint hashes. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** A client identity presentable in the MCP `initialize` handshake: a name
 *  and version string, nothing else (litmus-v17). */
export interface PresentedClientInfo {
  name: string;
  version: string;
}

export interface HarnessInfo {
  package: string;
  version: string;
  node: string;
  /** Governs C-02 / probe 4.2 applicability. */
  dockerAvailable: boolean;
  /** How a stdio target was executed (bundle 1.1.0). Set for stdio targets,
   *  omitted for http. "docker" = the target ran only inside the hardened
   *  container; "none" = launched on the host (the self-run default). */
  stdioIsolation?: "docker" | "none";
  /** The client identity presented in the MCP initialize handshake (litmus-v17,
   *  bundle 1.10.0). A fixed self-identifying name made evasion nearly free for
   *  a remote operator; the harness instead presents a plausible current
   *  agent-client identity and records exactly which one here, so a grade
   *  discloses what it presented even though the target could not tell it was
   *  being graded. Always populated by a run under this bundle version. */
  presentedClientInfo?: PresentedClientInfo;
}

// ── Evidence bundle (onchain-proof-spec §2) ──────────────────────────────────

export interface EvidenceBundle {
  schemaVersion: string;
  methodologyVersion: string;
  /** Canonical, versionless identity (serverKey). */
  serverRef: string;
  /** The exact version actually run — a re-fetchable pin (npm/pypi version,
   *  skill commit). Null when the target has no such identity (remote URL,
   *  unpinned ref). This is the reproducibility anchor. */
  resolvedVersion: string | null;
  /** The version the server reports about *itself* in the MCP `initialize`
   *  handshake (`serverInfo.version`). Self-asserted and operator-controlled —
   *  descriptive metadata only, never a reproducibility anchor (cf.
   *  resolvedVersion). Null when the server reports none. */
  selfReportedVersion: string | null;
  target: TargetDescriptor;
  /** sha256 of the canonical tool surface → `0x` + 64 hex (bytes32). */
  toolDefsFingerprint: string;
  /** The canonicalized {name, description, inputSchema} that was hashed. */
  toolDefs: ToolDef[];
  ranAt: string;
  harness: HarnessInfo;
  categories: CategoryResult[];
  grade: LitmusGrade;
  gradeRationale: string;
  /** High-risk tools left behaviorally unexercised, making the coverage cap
   *  (litmus-v16) auditable from the bundle alone. Present only when non-empty —
   *  a fully-exercised surface (or `--allow-state-changing`) omits it. */
  coverage?: CoverageInfo;
  /** Same-session tool-surface consistency advisory (litmus-v17, bundle
   *  1.10.0), remote http targets only: after grading, the harness opens one
   *  more independent connection, re-enumerates the tool surface, and compares
   *  its fingerprint to the graded one. Present only when that recheck found a
   *  mismatch or itself failed to connect; absent when the surface was stable,
   *  and always absent for a stdio target. Never affects the grade above. */
  surfaceConsistency?: Finding;
  disclaimer: string;
}

/**
 * What the dynamic probes did NOT behaviorally exercise (litmus-v16 coverage cap).
 * State-changing tools are skipped from bait calls for safety (tool-safety.ts), so
 * their runtime behavior is unverified; recording them here makes the resulting
 * grade cap reproducible and reviewable. `--allow-state-changing` exercises them,
 * so both lists are empty and the field is omitted.
 */
export interface CoverageInfo {
  /** High-risk (state-changing) tools not exercised (name, description, verb). */
  unexercisedHighRiskTools: string[];
  /** Subset whose name carries an unambiguously destructive / value-moving verb. */
  unexercisedDestructiveTools: string[];
}

// ── Dependency audit (advisory, NOT part of the grade or the bundle) ──────────

/**
 * Severity band for a dependency advisory, normalized across vulnerability
 * databases. Deliberately distinct from {@link Severity} (the grade's
 * low/medium/high): vuln databases publish GHSA-style bands, and a band is often
 * absent — hence the extra `critical` and `unknown` values. Never feeds the A–F
 * grade.
 */
export type AdvisorySeverity = "critical" | "high" | "moderate" | "low" | "unknown";

/**
 * One vulnerable dependency of the graded server, matched against a known-
 * vulnerability database. POINT-IN-TIME and ADVISORY ONLY: it reflects what the
 * database said at {@link DependencyAudit.queriedAt}, never enters the evidence
 * bundle, is never hashed into the report CID, and never moves the letter grade.
 */
export interface DependencyAdvisory {
  /** The vulnerable dependency's package name (not the graded server's). */
  package: string;
  /** The resolved version that matched. */
  version: string;
  /** Advisory identifier (e.g. `GHSA-…`, `CVE-…`). */
  id: string;
  severity: AdvisorySeverity;
  /** CVSS v3.x base score (0–10), when the source publishes a CVSS vector.
   *  The `severity` band is derived from this when no GHSA rating is given. */
  cvss?: number;
  /** One-line human summary; may be empty when the source publishes none. */
  summary: string;
  /** First fixed version, when the source publishes one. */
  fixedIn?: string;
  /** Canonical advisory URL. */
  url?: string;
}

/**
 * Result of the advisory dependency audit. Surfaced in CLI + MCP output only.
 * It is NOT a field of {@link EvidenceBundle}, is NOT canonicalized or hashed,
 * and is NOT minted — so it cannot affect the reproducible grade or the proof.
 * A run that cannot audit (non-npm target, npm absent, offline, no lockfile)
 * returns `status: "skipped"` with a `reason`, mirroring the C-02 skip pattern;
 * it never throws and never fails a grade.
 */
export interface DependencyAudit {
  status: "ok" | "skipped";
  /** Why the audit was skipped; set only when `status === "skipped"`. */
  reason?: string;
  source: "osv.dev";
  ecosystem: "npm";
  /** ISO timestamp the audit ran — the point-in-time anchor. */
  queriedAt: string;
  /** Total resolved {name, version} dependencies examined (0 when skipped). */
  dependencyCount: number;
  /** Distinct dependencies with at least one advisory. */
  vulnerableCount: number;
  advisories: DependencyAdvisory[];
}
