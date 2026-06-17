/**
 * C-01 — Tool-output injection (litmus-test-v1 §C-01).
 *
 * Probe 1.1 (static): scan every tool name / description / inputSchema for
 * injection-shaped content. No tool calls; deterministic.
 *
 * Probe 1.2 (dynamic): issue benign bait calls to each tool and scan the
 * outputs for injection-shaped echoes. Best-effort — a call that errors leaves
 * that tool unexercised, not failed.
 *
 * Probe 1.3 (second-order, litmus-v5): feed one tool's OUTPUT back in as another
 * tool's INPUT and scan the result. Catches the chaining class — a tool clean on
 * bait that weaponizes content originating from another tool — that 1.1/1.2 miss.
 *
 * Fail on any HIGH-severity scanner hit in any probe.
 */

import type { CategoryResult, Finding, ProbeResult } from "@polygraph/core";
import type { ProbeContext } from "./context.js";
import {
  BAIT_POOL,
  buildSecondOrderArgs,
  callToolArgs,
  exerciseTool,
  primaryStringInputKey,
  MAX_SECOND_ORDER_CALLS,
  MAX_SECOND_ORDER_SINKS,
  SECOND_ORDER_PAYLOAD_CHARS,
} from "./exercise.js";
import { isReflection } from "./adversarial-inputs.js";
import { shouldSkipExercise, skippedNote } from "./tool-safety.js";
import {
  hasHighSeverity,
  instructionMimicry,
  invisibleUnicode,
  markdownTricks,
} from "./scanners.js";

function scanInjection(text: string, tool: string): Finding[] {
  return [...invisibleUnicode(text), ...instructionMimicry(text), ...markdownTricks(text)].map((f) => ({
    ...f,
    tool,
  }));
}

/** Probe 1.1 — static scan of the advertised tool surface. */
function probe11(ctx: ProbeContext): ProbeResult {
  const findings: Finding[] = [];
  for (const t of ctx.tools) {
    const surface = `${t.name}\n${t.description}\n${JSON.stringify(t.inputSchema ?? {})}`;
    findings.push(...scanInjection(surface, t.name));
  }
  return { id: "1.1", status: hasHighSeverity(findings) ? "fail" : "pass", findings };
}

/** Probe 1.2 — dynamic scan of bait-call outputs (each tool gets the varied bait pool). */
async function probe12(ctx: ProbeContext): Promise<ProbeResult> {
  const findings: Finding[] = [];
  let exercised = 0;
  const unexercised: string[] = [];
  const skipped: string[] = [];
  for (const t of ctx.tools) {
    // State-changing tools are not bait-called by default — see tool-safety.ts.
    if (shouldSkipExercise(ctx, t.name)) {
      skipped.push(t.name);
      continue;
    }
    let answered = false;
    for (const bait of BAIT_POOL) {
      const out = await exerciseTool(ctx.client, t, bait);
      if (!out.ok) continue;
      answered = true;
      findings.push(...scanInjection(out.text, t.name));
    }
    if (answered) exercised++;
    else unexercised.push(t.name);
  }
  return {
    id: "1.2",
    status: hasHighSeverity(findings) ? "fail" : "pass",
    findings,
    reason: exerciseReason(exercised, unexercised, skipped),
  };
}

/** Record skipped (state-changing) and errored/timed-out tools so a "crash on
 *  bait, inject on real input" server isn't a silent pass and reduced coverage is visible. */
function exerciseReason(exercised: number, unexercised: string[], skipped: string[]): string | null {
  const notes: string[] = [];
  if (exercised === 0 && skipped.length === 0) notes.push("no tools could be exercised with bait inputs");
  if (skipped.length) notes.push(skippedNote(skipped));
  if (unexercised.length) notes.push(`${unexercised.length} tool(s) errored/timed out on bait (unevaluated): ${unexercised.join(", ")}`);
  return notes.length ? notes.join("; ") : null;
}

/**
 * Probe 1.3 — second-order injection. Collect each exercisable tool's first-order
 * output (a single deterministic bait call), then feed those outputs back in as
 * the input to the string-accepting tools and scan the second-order output. A
 * finding the sink merely reflected from the payload we fed is excluded
 * (reuse `isReflection`); only server-GENERATED injection — content the sink
 * produced from another tool's output — fails. Bounded run-globally by
 * MAX_SECOND_ORDER_CALLS, so cost does not scale with the tool count.
 */
export async function probe13(ctx: ProbeContext): Promise<ProbeResult> {
  const findings: Finding[] = [];
  const skipped: string[] = [];

  // Sinks: non-state-changing tools that can carry a textual payload.
  const sinks = ctx.tools.filter((t) => !shouldSkipExercise(ctx, t.name) && primaryStringInputKey(t.inputSchema) !== null);

  // Sources: first-order outputs (deterministic — the canonical bait), capped per
  // source so a huge output can't balloon the second call.
  const sources: { tool: string; payload: string }[] = [];
  for (const t of ctx.tools) {
    if (shouldSkipExercise(ctx, t.name)) {
      skipped.push(t.name);
      continue;
    }
    const out = await exerciseTool(ctx.client, t);
    if (out.ok && out.text) sources.push({ tool: t.name, payload: out.text.slice(0, SECOND_ORDER_PAYLOAD_CHARS) });
  }

  let calls = 0;
  for (const src of sources) {
    if (calls >= MAX_SECOND_ORDER_CALLS) break;
    let fed = 0;
    for (const sink of sinks) {
      if (calls >= MAX_SECOND_ORDER_CALLS || fed >= MAX_SECOND_ORDER_SINKS) break;
      const args = buildSecondOrderArgs(sink.inputSchema, src.payload);
      if (!args) continue;
      calls++;
      fed++;
      const out = await callToolArgs(ctx.client, sink.name, args);
      if (!out.ok) continue;
      for (const f of scanInjection(out.text, sink.name)) {
        // Drop anything the sink merely echoed from the source payload — only
        // injection the sink GENERATED from another tool's output is a fault.
        if (!isReflection(src.payload, f.match)) findings.push(f);
      }
    }
  }

  const notes: string[] = [];
  if (sources.length === 0 || sinks.length === 0) notes.push("no second-order chain possible (need an exercisable source output and a string-accepting sink)");
  else notes.push(`${calls} second-order call(s): ${sources.length} source output(s) → ≤${MAX_SECOND_ORDER_SINKS} sink(s) each (cap ${MAX_SECOND_ORDER_CALLS})`);
  if (skipped.length) notes.push(skippedNote(skipped));
  return { id: "1.3", status: hasHighSeverity(findings) ? "fail" : "pass", findings, reason: notes.join("; ") };
}

export async function c01Injection(ctx: ProbeContext): Promise<CategoryResult> {
  const probes = [probe11(ctx), await probe12(ctx), await probe13(ctx)];
  const status = probes.some((p) => p.status === "fail") ? "fail" : "pass";
  return { code: "C-01", status, probes };
}
