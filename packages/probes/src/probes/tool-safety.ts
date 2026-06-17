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
  /** The tool's JSON-schema-ish inputSchema (litmus-v5: read by
   *  {@link declarationMismatchV2} for mutation-evidencing parameter names). */
  inputSchema?: unknown;
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
 * The unambiguously destructive / value-moving subset of {@link STATE_CHANGING_VERBS}.
 * Used by {@link declarationMismatch} to catch a server that *claims* a tool is
 * read-only while its name plainly says it mutates. Deliberately narrower than
 * STATE_CHANGING_VERBS: polysemous verbs (`create`/`update`/`execute`/`move`/
 * `order`/`insert`/`write`) are excluded so an honest `create_query` or
 * `update_cache` tool annotated read-only is not flagged a liar.
 */
const UNAMBIGUOUS_DESTRUCTIVE_VERBS = new Set([
  "delete",
  "drop",
  "transfer",
  "send",
  "withdraw",
  "pay",
  "sign",
  "burn",
  "revoke",
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

/**
 * Detect a *declared-permission lie* (litmus-test-v1 §C-02 probe 2.1): a tool
 * that annotates itself `readOnlyHint:true` while its name carries an
 * unambiguously destructive verb. Returns the offending verb token, or `null`.
 *
 * The mismatch requires an explicit read-only *claim* — an unannotated
 * `delete_*` tool is honest (the verb heuristic already skips it from active
 * exercise) and is not a lie, only the read-only claim makes it one.
 */
export function declarationMismatch(tool: ToolSafetyInput): string | null {
  if (tool.annotations?.readOnlyHint !== true) return null;
  return tokenize(tool.name).find((t) => UNAMBIGUOUS_DESTRUCTIVE_VERBS.has(t)) ?? null;
}

/**
 * Parameter names that, on a read-only-CLAIMING tool, are strong evidence of
 * mutation or value/secret movement. Compared against each schema key's
 * *collapsed* form (lowercased, separators removed: `to_address`/`toAddress` →
 * `toaddress`), so snake/camel/kebab all normalize the same. Deliberately NARROW
 * and matched by exact membership — polysemous names (`id`/`value`/`data`/`name`/
 * `content`/`key`/`path`) are excluded so an honest read-only tool isn't flagged
 * (`amount` matches; `paramount` does not).
 */
const MUTATION_PARAM_COLLAPSED = new Set([
  "recipient",
  "recipients",
  "toaddress",
  "destinationaddress",
  "payee",
  "amount",
  "amountwei",
  "valuewei",
  "privatekey",
  "mnemonic",
  "seedphrase",
  "writepath",
  "outputpath",
  "destpath",
  "destinationpath",
]);

/**
 * Description phrases that, on a read-only-CLAIMING tool, unambiguously evidence
 * mutation. Mirrors {@link UNAMBIGUOUS_DESTRUCTIVE_VERBS}' precision: bare
 * `send`/`write`/`update`/`create`/`move` are excluded (a read-only tool may
 * legitimately "send a request" or "create a query"); only value-movement objects
 * (`send funds`, `signs a transaction`) and unambiguous verbs trip.
 */
const MUTATION_DESC_PATTERNS: readonly RegExp[] = [
  /\b(?:deletes?|deleting|deletion)\b/i,
  /\b(?:transfers?|transferring)\b/i,
  /\b(?:withdraws?|withdrawing|withdrawal)\b/i,
  /\bsends?\s+(?:funds|money|payments?|tokens|a\s+transaction)\b/i,
  /\bsigns?\s+(?:a\s+)?transaction\b/i,
  /\b(?:revokes?|revoking)\b/i,
  /\bburns?\s+tokens?\b/i,
];

/** Where a declared-permission lie was evidenced. */
export interface MislabelEvidence {
  source: "name" | "param" | "description";
  /** The offending verb token, parameter key, or description phrase. */
  detail: string;
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return {};
  const s = schema as { properties?: unknown };
  return s.properties && typeof s.properties === "object" ? (s.properties as Record<string, unknown>) : {};
}

/**
 * litmus-v5 extension of {@link declarationMismatch}: a tool that claims
 * `readOnlyHint:true` is lying if its NAME, a PARAMETER, or its DESCRIPTION
 * evidences mutation. Checked name → param → description, returning the strongest
 * evidence (or `null`). Each layer is deliberately narrow (see the sets above) so
 * an honest read-only tool is never flagged. Requires the explicit read-only
 * *claim* — an unannotated mutator is honest, not a liar.
 */
export function declarationMismatchV2(tool: ToolSafetyInput): MislabelEvidence | null {
  if (tool.annotations?.readOnlyHint !== true) return null;

  const nameVerb = tokenize(tool.name).find((t) => UNAMBIGUOUS_DESTRUCTIVE_VERBS.has(t));
  if (nameVerb) return { source: "name", detail: nameVerb };

  for (const key of Object.keys(schemaProperties(tool.inputSchema))) {
    const collapsed = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (MUTATION_PARAM_COLLAPSED.has(collapsed)) return { source: "param", detail: key };
  }

  const desc = tool.description ?? "";
  for (const re of MUTATION_DESC_PATTERNS) {
    const m = re.exec(desc);
    if (m) return { source: "description", detail: m[0] };
  }

  return null;
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
