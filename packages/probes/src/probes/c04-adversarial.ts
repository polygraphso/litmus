/**
 * C-04 — Adversarial input handling (litmus-test-v1 §C-04, litmus-v4).
 *
 * Probe 3.1 (malformed/oversized): stress each tool with malformed and oversized
 * inputs. FAIL if the server stops responding (crash/hang) or leaks an uncaught
 * stack trace in its output; a clean validation error or benign result is a PASS.
 *
 * Probe 3.2 (jailbreak amplification): feed jailbreak-pattern strings as inputs
 * and scan the OUTPUTS with the C-01 injection scanners. FAIL if the server emits
 * injection-shaped content it did NOT merely reflect from our input — i.e. it
 * weaponized hostile input. A verbatim echo is not a fault and is excluded, so an
 * honest echo/summarize tool is not false-floored.
 *
 * Both probes only exercise non-state-changing tools (tool-safety.ts), so C-04
 * never fires `send`/`delete`/`transfer`/… , and both run anywhere — no Docker.
 * A C-04 failure caps the overall grade at D (grade.ts).
 */

import type { CategoryResult, Finding, ProbeResult } from "@polygraph/core";
import type { ProbeContext } from "./context.js";
import { callToolArgs, exerciseTool, serverResponsive } from "./exercise.js";
import { buildMalformedArgs, maskPayloadEchoes, maskRejectionEchoes, JAILBREAK_POOL } from "./adversarial-inputs.js";
import { shouldSkipExercise, skippedNote } from "./tool-safety.js";
import { hasHighSeverity, instructionMimicry, internalsLeak, invisibleUnicode, markdownTricks } from "./scanners.js";

/** Probe 3.1 — malformed/oversized input resilience. */
async function probe31(ctx: ProbeContext): Promise<ProbeResult> {
  const findings: Finding[] = [];
  const skipped: string[] = [];
  let probed = 0;
  let crashedAt: string | null = null;

  for (const t of ctx.tools) {
    if (shouldSkipExercise(ctx, t.name)) {
      skipped.push(t.name);
      continue;
    }
    probed++;
    let timedOut = false;
    for (const m of buildMalformedArgs(t.inputSchema)) {
      const out = await callToolArgs(ctx.client, t.name, m.args);
      // Scan both the result body and the JSON-RPC error channel: a stack trace or
      // internals leak returned as a protocol-level error is as actionable as one
      // returned in a normal (isError) result.
      if (out.ok) {
        findings.push(...internalsLeak(out.text).map((f) => ({ ...f, tool: t.name })));
      } else if (out.reason === "timeout") {
        timedOut = true;
      } else {
        findings.push(...internalsLeak(out.errorText).map((f) => ({ ...f, tool: t.name })));
      }
    }
    // A hang is a crash signal — confirm the server is unresponsive (a graceful
    // rejection or a single slow call leaves it alive) and stop, rather than
    // time out on every remaining tool.
    if (timedOut && !(await serverResponsive(ctx.client))) {
      crashedAt = t.name;
      break;
    }
  }

  // The malformed battery may have made the server exit BETWEEN calls (no single
  // call timed out): one final liveness round-trip catches that too.
  if (!crashedAt && probed > 0 && !(await serverResponsive(ctx.client))) {
    crashedAt = "(malformed-input probing)";
  }
  if (crashedAt) {
    findings.push({
      kind: "crash",
      severity: "high",
      ...(crashedAt.startsWith("(") ? {} : { tool: crashedAt }),
      match: `server stopped responding after a malformed/oversized input to ${crashedAt}`,
    });
  }

  return {
    id: "3.1",
    status: hasHighSeverity(findings) ? "fail" : "pass",
    findings,
    reason: skipped.length ? skippedNote(skipped) : null,
  };
}

/** Probe 3.2 — jailbreak amplification (server-generated injection from hostile input). */
async function probe32(ctx: ProbeContext): Promise<ProbeResult> {
  const findings: Finding[] = [];
  const skipped: string[] = [];
  for (const t of ctx.tools) {
    if (shouldSkipExercise(ctx, t.name)) {
      skipped.push(t.name);
      continue;
    }
    for (const jailbreak of JAILBREAK_POOL) {
      const out = await exerciseTool(ctx.client, t, jailbreak);
      if (!out.ok) continue;
      // Mask reflections of our own input before scanning: first any echo of our
      // hostile input inside a REJECTION frame (a safe refusal — Pydantic
      // input_value='…', `Invalid label "…"`, `Error: … not found: …` — including
      // char-stripped/truncated echoes), then complete echoes of ANY injected
      // payload. Only server-GENERATED injection survives — a compliant server that
      // echoes a payload prefix and splices NOVEL injection isn't a rejection, so
      // its injection token is left intact and flagged.
      const masked = maskPayloadEchoes(maskRejectionEchoes(out.text, JAILBREAK_POOL), JAILBREAK_POOL);
      const scanned = [...invisibleUnicode(masked), ...instructionMimicry(masked), ...markdownTricks(masked)];
      for (const f of scanned) findings.push({ ...f, tool: t.name });
    }
  }
  return {
    id: "3.2",
    status: hasHighSeverity(findings) ? "fail" : "pass",
    findings,
    reason: skipped.length ? skippedNote(skipped) : null,
  };
}

export async function c04Adversarial(ctx: ProbeContext): Promise<CategoryResult> {
  const p31 = await probe31(ctx);
  // If 3.1 left the server unresponsive, 3.2 can't meaningfully run — record it
  // skipped rather than reporting a false pass over a dead server.
  const crashed = p31.findings.some((f) => f.kind === "crash");
  const p32: ProbeResult = crashed
    ? { id: "3.2", status: "skipped", findings: [], reason: "server unresponsive after probe 3.1 — jailbreak probe not run" }
    : await probe32(ctx);
  const status = p31.status === "fail" || p32.status === "fail" ? "fail" : "pass";
  return { code: "C-04", status, probes: [p31, p32] };
}
