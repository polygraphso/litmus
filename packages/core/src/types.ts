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
 *  field on the attestation, so v1–v6 attestations coexist and the agent gate does
 *  not branch on it. v6 widens the default tool-safety skip set: a tool that claims
 *  read-only but evidences mutation is no longer actively exercised, which can
 *  change which tools are probed (hence the grade) on such servers. */
export const METHODOLOGY_VERSION = "litmus-v6" as const;
/** Evidence-bundle format version (owned by onchain-proof-spec §2).
 *  1.5.0 adds the optional `selfReportedVersion` field (the server's
 *  self-asserted `serverInfo.version`, descriptive metadata only);
 *  1.4.0 adds the C-01 probe id `1.3` (second-order injection, litmus-v5);
 *  1.3.0 adds the optional C-04 category and the `internals-leak`/`crash` finding
 *  kinds (litmus-v4); 1.2.0 adds the optional `target.declaredEgress` field and
 *  the `egress-allowed` finding kind (litmus-v3); 1.1.0 adds
 *  `harness.stdioIsolation`; older remain valid. */
export const BUNDLE_SCHEMA_VERSION = "1.5.0" as const;

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
 *  3=adversarial-input, 4=sensitive). 1.3 (second-order injection) added in v5. */
export type ProbeId = "1.1" | "1.2" | "1.3" | "2.1" | "2.2" | "3.1" | "3.2" | "4.1" | "4.2";

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
  | "markdown-trick"
  | "canary"
  | "egress"
  | "egress-allowed"
  | "permission-mislabel"
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
  disclaimer: string;
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
