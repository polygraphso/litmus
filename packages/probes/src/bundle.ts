/**
 * Assemble the canonical evidence bundle (onchain-proof-spec §2).
 *
 * Content-addressed: its hash is its identity, so the `evidenceHash` in the
 * attestation pins this exact document (re-hash the published evidence to verify).
 * Canonicalization (sorted keys etc.) is applied when it's serialized for hashing;
 * here we build the in-memory shape.
 */

import { createRequire } from "node:module";
import type {
  CategoryResult,
  CoverageInfo,
  EvidenceBundle,
  Finding,
  HarnessInfo,
  PresentedClientInfo,
  TargetDescriptor,
  ToolDef,
} from "@polygraph/core";
import { BUNDLE_SCHEMA_VERSION, METHODOLOGY_VERSION } from "@polygraph/core";
import type { Grade } from "./grade.js";

const require = createRequire(import.meta.url);
const PKG_VERSION: string = (() => {
  try {
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const DISCLAIMER =
  `Self-run, self-minted under ${METHODOLOGY_VERSION}. Independence traded for cost. Re-run the open harness to verify.`;

export interface BundleInput {
  serverRef: string;
  resolvedVersion: string | null;
  selfReportedVersion: string | null;
  target: TargetDescriptor;
  toolDefsFingerprint: string;
  toolDefs: ToolDef[];
  categories: CategoryResult[];
  grade: Grade;
  /** High-risk tools left unexercised (litmus-v16 coverage cap). Recorded only
   *  when non-empty; omitted for a fully-exercised surface. */
  coverage?: CoverageInfo;
  ranAt: string;
  dockerAvailable: boolean;
  /** How a stdio target was executed (bundle 1.1.0). Set for stdio targets;
   *  omitted for http (isolation is stdio-only). */
  stdioIsolation?: "docker" | "none";
  /** The client identity presented in the MCP initialize handshake
   *  (litmus-v17). Always supplied by a real harness run; optional here only
   *  so a bare/synthetic bundle construction still typechecks. */
  presentedClientInfo?: PresentedClientInfo;
  /** Same-session tool-surface consistency advisory (litmus-v17, remote http
   *  targets only). Present only when the post-grade recheck found a drift or
   *  itself failed to connect; never affects the grade. */
  surfaceConsistency?: Finding;
  /** Override the baked disclaimer (e.g. the hosted operator-run string). The
   *  local self-run default is used when this is absent. */
  disclaimer?: string;
}

export function assembleBundle(input: BundleInput): EvidenceBundle {
  const harness: HarnessInfo = {
    package: "@polygraph/probes",
    version: PKG_VERSION,
    node: process.version,
    dockerAvailable: input.dockerAvailable,
    ...(input.stdioIsolation ? { stdioIsolation: input.stdioIsolation } : {}),
    ...(input.presentedClientInfo ? { presentedClientInfo: input.presentedClientInfo } : {}),
  };

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    methodologyVersion: METHODOLOGY_VERSION,
    serverRef: input.serverRef,
    resolvedVersion: input.resolvedVersion,
    selfReportedVersion: input.selfReportedVersion,
    target: input.target,
    toolDefsFingerprint: input.toolDefsFingerprint,
    toolDefs: input.toolDefs,
    ranAt: input.ranAt,
    harness,
    categories: input.categories,
    grade: input.grade.grade,
    gradeRationale: input.grade.rationale,
    ...(input.coverage && input.coverage.unexercisedHighRiskTools.length > 0
      ? { coverage: input.coverage }
      : {}),
    ...(input.surfaceConsistency ? { surfaceConsistency: input.surfaceConsistency } : {}),
    disclaimer: input.disclaimer ?? DISCLAIMER,
  };
}
