/**
 * C-02 — Permission overreach (litmus-test-v1 §C-02). Two probes:
 *
 *  - **2.1 declared-permission honesty** — a tool that annotates itself
 *    `readOnlyHint:true` while its name plainly mutates is lying about its
 *    permissions; an agent (and this harness) would otherwise auto-trust it.
 *    Static, deterministic, no sandbox — so it can fail even a remote target.
 *  - **2.2 unexpected egress** — the egress sandbox (docker/egress-runner.ts)
 *    runs the target and captures what it tried to reach; any outbound attempt
 *    during a no-expected-egress run is a finding. When the sandbox didn't run
 *    (no Docker / non-launchable target), 2.2 is `skipped` — never silently
 *    dropped (the grade caps at B).
 *
 * Category verdict: a 2.1 or 2.2 failure fails C-02 (→ grade D). C-02 is only
 * `skipped` when 2.1 passed and 2.2 could not run.
 */

import type { CategoryResult, CategoryStatus, Finding, ProbeResult } from "@polygraph/core";
import {
  egressToFindings,
  egressAllowedFindings,
  correlateEgress,
  classifyEgress,
  type EgressResult,
  type ClassifiedEgress,
} from "../docker/egress-runner.js";
import { effectiveAllowlist } from "./egress-allowlist.js";
import { declarationMismatchV2, type MislabelEvidence, type ToolSafetyInput } from "./tool-safety.js";
import { matchExpectedUpstream, type ExpectedUpstreamSignal } from "./expected-upstream.js";

/** The human-readable evidence for a declared-permission lie, by where it was found. */
function mislabelMessage(ev: MislabelEvidence): string {
  switch (ev.source) {
    case "name":
      return `claims readOnlyHint:true but name verb "${ev.detail}" mutates`;
    case "param":
      return `claims readOnlyHint:true but parameter "${ev.detail}" evidences mutation / value movement`;
    case "description":
      return `claims readOnlyHint:true but its description says "${ev.detail}" (mutation)`;
  }
}

/**
 * Probe 2.1 — flag tools that claim read-only (`readOnlyHint:true`) while their
 * NAME, a PARAMETER, or their DESCRIPTION evidences mutation (litmus-v5 widens the
 * v4 name-only check). Static, deterministic, no sandbox.
 */
export function probe21Declaration(tools: readonly ToolSafetyInput[]): ProbeResult {
  const findings: Finding[] = [];
  for (const t of tools) {
    const ev = declarationMismatchV2(t);
    if (ev) {
      findings.push({
        kind: "permission-mislabel",
        severity: "high",
        match: mislabelMessage(ev),
        tool: t.name,
      });
    }
  }
  return { id: "2.1", status: findings.length > 0 ? "fail" : "pass", findings };
}

/** An empty signal — the default when a run supplies none (v10 behavior). */
const EMPTY_UPSTREAM_SIGNAL: ExpectedUpstreamSignal = { hostMentions: [], brandLabels: new Set() };

/** Informational findings for undeclared egress inferred to be the server's own
 *  advertised upstream (litmus-v11). Recorded as disclosure — not exoneration —
 *  exactly as `egress-allowed` is; it does not fail C-02. */
function egressInferredFindings(inferred: readonly ClassifiedEgress[], signal: ExpectedUpstreamSignal): Finding[] {
  return inferred.map((c) => {
    const m = c.host ? matchExpectedUpstream(c.host, signal) : null;
    return {
      kind: "egress-inferred",
      severity: "low",
      match: `${c.host ?? "?"}${c.port ? `:${c.port}` : ""} — inferred upstream${m ? ` (${m.via}: ${m.token})` : ""}`,
      ...(c.host !== undefined ? { host: c.host } : {}),
      ...(c.port !== undefined ? { port: c.port } : {}),
    };
  });
}

/**
 * Probe 2.2 — egress overreach (litmus-v3). Egress to a host the server DECLARED
 * (`polygraph.egress`) or on the operator BASELINE allowlist is permitted and
 * recorded as informational; egress BEYOND that union — or an attempt with no
 * resolvable host — is overreach and fails. Skipped when the sandbox didn't run.
 *
 * litmus-v11 adds a second pass: an undeclared host that the server's own tool
 * surface identifies as its advertised upstream (an API wrapper reaching the API
 * it wraps) is peeled out of overreach into an informational `egress-inferred`
 * finding, so it no longer fails C-02. A host with no such relationship stays
 * overreach. The pass only ever removes attempts from the overreach set.
 */
function probe22Egress(egress: EgressResult, signal: ExpectedUpstreamSignal): ProbeResult {
  if (!egress.ran) return { id: "2.2", status: "skipped", findings: [], reason: egress.reason };
  const allowlist = effectiveAllowlist(egress.baselineAllowlist, egress.declaredEgress);
  const classified = classifyEgress(correlateEgress(egress.attempts), allowlist);
  const allowed = classified.filter((c) => c.allowed);
  const notAllowed = classified.filter((c) => !c.allowed);
  // A no-host attempt can never be inferred (conservative → stays overreach).
  const inferable = (c: ClassifiedEgress): boolean => c.host !== undefined && matchExpectedUpstream(c.host, signal) !== null;
  const inferred = notAllowed.filter(inferable);
  const overreach = notAllowed.filter((c) => !inferable(c));
  const findings: Finding[] = [
    ...egressToFindings(overreach),
    ...egressAllowedFindings(allowed),
    ...egressInferredFindings(inferred, signal),
  ];
  if (overreach.length > 0) return { id: "2.2", status: "fail", findings };
  const notes: string[] = [];
  if (allowed.length > 0) notes.push(`${allowed.length} declared/baseline egress attempt(s) permitted`);
  if (inferred.length > 0) notes.push(`${inferred.length} inferred-upstream egress attempt(s) permitted`);
  return {
    id: "2.2",
    status: "pass",
    findings,
    reason: notes.length > 0 ? `${notes.join("; ")}; 0 overreach` : null,
  };
}

/** Assemble the C-02 category from probe 2.1 (declaration) and probe 2.2 (egress).
 *  `signal` (litmus-v11) lets 2.2 recognize a server's own advertised upstream;
 *  it defaults to empty so a caller that supplies none gets v10 behavior. */
export function c02Permission(
  declaration: ProbeResult,
  egress: EgressResult,
  signal: ExpectedUpstreamSignal = EMPTY_UPSTREAM_SIGNAL,
): CategoryResult {
  const egressProbe = probe22Egress(egress, signal);
  const probes = [declaration, egressProbe];

  let status: CategoryStatus;
  if (declaration.status === "fail" || egressProbe.status === "fail") {
    status = "fail";
  } else if (egressProbe.status === "skipped") {
    // 2.1 passed, egress couldn't run: honest about not verifying egress (B-cap).
    return { code: "C-02", status: "skipped", reason: egress.reason, probes };
  } else {
    status = "pass";
  }
  return { code: "C-02", status, probes };
}
