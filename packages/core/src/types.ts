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
 *  v2 adds C-02 probe 2.1 (declared-permission honesty), a new fail condition —
 *  a pass/fail-semantics change, so the version bumps per litmus-test §8. */
export const METHODOLOGY_VERSION = "litmus-v2" as const;
/** Evidence-bundle format version (owned by onchain-proof-spec §2).
 *  1.1.0 adds the optional `harness.stdioIsolation` field and permits the
 *  disclaimer to vary by run mode; 1.0.0 bundles remain valid. */
export const BUNDLE_SCHEMA_VERSION = "1.1.0" as const;

// ── Categories & probes (litmus-test-v1 §2) ──────────────────────────────────

export type CategoryCode = "C-01" | "C-02" | "C-03" | "C-04";
/** Probe IDs carry their family number (1=injection, 2=permission, 4=sensitive). */
export type ProbeId = "1.1" | "1.2" | "2.1" | "2.2" | "4.1" | "4.2";

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
  | "permission-mislabel";

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** The matched substring (or a hex dump, for invisible characters). */
  match: string;
  /** Byte offset where the match starts, when applicable. */
  offset?: number;
  /** Offending tool name, when the finding is tied to one. */
  tool?: string;
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
  /** The exact version actually run. */
  resolvedVersion: string | null;
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
