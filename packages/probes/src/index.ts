export { runLitmus, enumerateTools, isDockerAvailable, type TargetInput, type RunLitmusOptions, type ListToolsClient } from "./harness.js";
/** @deprecated Use `RunLitmusOptions`. */
export type { RunLitmusOptions as LitmusOptions } from "./harness.js";
export { connectTarget, type ConnectedTarget, type ConnectOptions, type StdioCommand } from "./connect/index.js";
export { fingerprintToolDefs, type FingerprintResult } from "./fingerprint.js";
export { gradeFromCategories, type Grade } from "./grade.js";
export { assembleBundle, type BundleInput } from "./bundle.js";
// Advisory dependency audit (point-in-time OSV.dev scan of an npm target's
// dependency tree). Separate from the A–F grade and the evidence bundle by
// design — surfaced in CLI/MCP output only.
export { auditDependencies, parseLockfile, type AuditDependenciesOptions } from "./deps/audit.js";
export * from "./probes/scanners.js";
// Skill litmus (litmus-skill-v1): static safety grade for Claude Code skills.
export * from "./skills/index.js";
export {
  classifyTool,
  stateChangingToolNames,
  unsafeToExerciseToolNames,
  type ToolAnnotations,
  type ToolSafety,
} from "./probes/tool-safety.js";
export type { ProbeContext } from "./probes/context.js";
// Advisory LLM judge over an MCP tool surface (litmus-v16). Non-deterministic,
// never in the evidence bundle, never affects the A–F letter — surfaced in the
// MCP/CLI summary only, exactly like the dependency audit.
export { judgeInjection, type JudgedInjection } from "./probes/injection-judge.js";
