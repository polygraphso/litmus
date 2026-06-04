/**
 * `@polygraphso/litmus` — the public library surface for the behavioral litmus
 * harness, bundled from the internal `@polygraph/*` workspace packages.
 *
 * The CLI (`polygraphso-litmus`) and MCP server (`polygraphso-litmus-mcp`) bins
 * are separate entry points; this module is what you `import` programmatically.
 */

// Contract types + canonical JSON + identity helpers (EvidenceBundle, LitmusGrade,
// CategoryResult, Finding, canonicalStringify, parseServerRef, …).
export * from "@polygraph/core";

// The harness: runLitmus + connection/fingerprint/grade/bundle primitives and
// the injection scanners.
export * from "@polygraph/probes";

// Onchain proof layer: read/encode/decode EAS attestations, bond reads, network
// config. (Write paths — attestLitmus/stakeBond — require a funded signer.)
export * from "@polygraph/onchain";

// Agent-gate decision logic. Re-exported explicitly because `@polygraph/agent`
// and `@polygraph/onchain` both define a `BondView`; onchain's wins the `export
// *` above, and gateDecision accepts it structurally.
export { gateDecision, liveFingerprint, DEFAULT_PASSING } from "@polygraph/agent";
export type { AttestationView, GateAction, GateDecision } from "@polygraph/agent";

// The run_litmus MCP tool's handler, exposed for embedding in a custom server.
export {
  RUN_LITMUS_TOOL_NAME,
  RUN_LITMUS_TOOL_TITLE,
  RUN_LITMUS_TOOL_DESCRIPTION,
  runLitmusInputShape,
  handleRunLitmus,
} from "./tools/run-litmus.js";
