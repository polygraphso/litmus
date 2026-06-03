/**
 * Assemble the canonical evidence bundle (onchain-proof-spec §2).
 *
 * Content-addressed: its CID is its hash, so the `reportCID` in the attestation
 * pins this exact document. Canonicalization (sorted keys etc.) is applied when
 * it's serialized for pinning; here we build the in-memory shape.
 */

import { createRequire } from "node:module";
import type {
  CategoryResult,
  EvidenceBundle,
  HarnessInfo,
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
  "Self-run, self-minted under litmus-v1. Independence traded for cost. Re-run the open harness to verify.";

export interface BundleInput {
  serverRef: string;
  resolvedVersion: string | null;
  target: TargetDescriptor;
  toolDefsFingerprint: string;
  toolDefs: ToolDef[];
  categories: CategoryResult[];
  grade: Grade;
  ranAt: string;
  dockerAvailable: boolean;
}

export function assembleBundle(input: BundleInput): EvidenceBundle {
  const harness: HarnessInfo = {
    package: "@polygraph/probes",
    version: PKG_VERSION,
    node: process.version,
    dockerAvailable: input.dockerAvailable,
  };

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    methodologyVersion: METHODOLOGY_VERSION,
    serverRef: input.serverRef,
    resolvedVersion: input.resolvedVersion,
    target: input.target,
    toolDefsFingerprint: input.toolDefsFingerprint,
    toolDefs: input.toolDefs,
    ranAt: input.ranAt,
    harness,
    categories: input.categories,
    grade: input.grade.grade,
    gradeRationale: input.grade.rationale,
    disclaimer: DISCLAIMER,
  };
}
