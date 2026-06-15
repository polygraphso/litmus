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

// Onchain proof layer: READ/encode/decode EAS attestations + network config.
// Minting (the funded-signer write path) is NOT part of this package — it lives
// in the web app flow.
export * from "@polygraph/onchain";

// Agent-gate decision logic, re-exported explicitly to keep the public surface
// narrow (the internal harness helpers aren't part of this package's API).
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

// CLI target/auth helpers, re-exported for programmatic harness drivers (e.g. a
// hosted runner) that need to resolve a target and parse auth flags exactly the
// way the bundled CLI does, rather than reimplementing that resolution.
export { parseAuthFlags, resolveTarget } from "@polygraph/cli/litmus";
export type { ParsedLitmusFlags, StdioCommand } from "@polygraph/cli/litmus";
