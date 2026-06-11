/**
 * Tool-safety classification (litmus-test-v1 §C-01/§C-03 safety note).
 *
 * The dynamic probes (C-01 1.2, C-03 4.1) call tools with bait inputs. Against
 * an authenticated server that can move money or mutate state — a wallet's
 * `send`/`swap`/`sign`, a database's `delete` — that is unacceptable. So by
 * default we do NOT actively call tools classified as state-changing: they are
 * still fingerprinted and statically scanned (1.1), but recorded as skipped,
 * not exercised. `--allow-state-changing` opts back into full exercise.
 *
 * Classification is conservative (prefer skipping a safe tool over calling a
 * dangerous one) and uses, in order: MCP tool annotations, then a verb
 * heuristic on the name/description.
 */

/** The MCP tool annotation hints we read (a subset of the spec's annotations). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface ToolSafetyInput {
  name: string;
  description?: string;
  annotations?: ToolAnnotations | null;
}

export interface ToolSafety {
  stateChanging: boolean;
  /** Why it was classified state-changing (for the probe's skip reason). */
  reason?: string;
}

/**
 * Verbs that signal a tool mutates external state or moves value. Matched
 * against the *tokens* of the tool name (see `tokenize`) — not the description,
 * which is too noisy (a read-only tool whose docs say "call this before you
 * send funds" must stay exercisable). Conservative by design: a false
 * "state-changing" only costs coverage (the tool is skipped, not failed); a
 * false "safe" could trigger a real transaction.
 */
const STATE_CHANGING_VERBS = new Set([
  "send",
  "transfer",
  "swap",
  "sign",
  "pay",
  "buy",
  "sell",
  "trade",
  "approve",
  "withdraw",
  "deposit",
  "mint",
  "burn",
  "execute",
  "deploy",
  "delete",
  "remove",
  "drop",
  "write",
  "create",
  "update",
  "insert",
  "revoke",
  "grant",
  "move",
  "rename",
  "purchase",
  "checkout",
  "order",
]);

/**
 * Split an identifier into lowercase word tokens, handling snake_case,
 * kebab-case, camelCase, and dotted/namespaced names. `\b…\b` cannot do this —
 * `_` is a regex word character, so `\bsend\b` never matches `send_calls`.
 */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase boundary → space
    .split(/[^a-zA-Z0-9]+/) // split on _, -, ., whitespace, …
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** Classify whether a tool should be skipped from active (bait-call) exercise. */
export function classifyTool(tool: ToolSafetyInput): ToolSafety {
  const ann = tool.annotations ?? undefined;
  // Annotations are authoritative when present.
  if (ann?.readOnlyHint === true) return { stateChanging: false };
  if (ann?.destructiveHint === true) return { stateChanging: true, reason: "annotated destructiveHint" };
  if (ann?.readOnlyHint === false) return { stateChanging: true, reason: "annotated readOnlyHint:false" };

  // Otherwise fall back to a verb heuristic on the tool name's tokens.
  const verb = tokenize(tool.name).find((t) => STATE_CHANGING_VERBS.has(t));
  if (verb) return { stateChanging: true, reason: `name token "${verb}" is state-changing` };

  return { stateChanging: false };
}

/** Names of the tools in a surface that are state-changing (skipped by default). */
export function stateChangingToolNames(tools: readonly ToolSafetyInput[]): Set<string> {
  const names = new Set<string>();
  for (const t of tools) {
    if (classifyTool(t).stateChanging) names.add(t.name);
  }
  return names;
}

/** The coverage note a dynamic probe records for tools it skipped for safety. */
export function skippedNote(skipped: readonly string[]): string {
  return `${skipped.length} tool(s) skipped (state-changing; pass --allow-state-changing): ${skipped.join(", ")}`;
}

/** Whether a probe should skip actively calling this tool, given the run's policy. */
export function shouldSkipExercise(
  ctx: { allowStateChanging: boolean; stateChangingTools: ReadonlySet<string> },
  toolName: string,
): boolean {
  return !ctx.allowStateChanging && ctx.stateChangingTools.has(toolName);
}
