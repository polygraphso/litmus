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
 * Fail on any HIGH-severity scanner hit in either probe.
 */

import type { CategoryResult, Finding, ProbeResult } from "@polygraph/core";
import type { ProbeContext } from "./context.js";
import { BAIT_POOL, exerciseTool } from "./exercise.js";
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
  for (const t of ctx.tools) {
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
  return { id: "1.2", status: hasHighSeverity(findings) ? "fail" : "pass", findings, reason: exerciseReason(exercised, unexercised) };
}

/** Record errored/timed-out tools so a "crash on bait, inject on real input" server isn't a silent pass. */
function exerciseReason(exercised: number, unexercised: string[]): string | null {
  const notes: string[] = [];
  if (exercised === 0) notes.push("no tools could be exercised with bait inputs");
  if (unexercised.length) notes.push(`${unexercised.length} tool(s) errored/timed out on bait (unevaluated): ${unexercised.join(", ")}`);
  return notes.length ? notes.join("; ") : null;
}

export async function c01Injection(ctx: ProbeContext): Promise<CategoryResult> {
  const probes = [probe11(ctx), await probe12(ctx)];
  const status = probes.some((p) => p.status === "fail") ? "fail" : "pass";
  return { code: "C-01", status, probes };
}
