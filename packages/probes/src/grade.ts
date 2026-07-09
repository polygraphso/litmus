/**
 * Grading rubric (litmus-test-v1 §5, coverage cap litmus-v16). A single letter
 * A–F, always with a rationale (never a bare letter).
 *
 *   F — any C-01 or C-03 failure (injection or data leak)
 *   D — C-02 or C-04 failure (egress overreach, or a crash / internals-leak /
 *       jailbreak amplification on adversarial input), no C-01/C-03 failure
 *   A — all four categories pass AND the high-risk tool surface was actually
 *       exercised (no coverage gap)
 *   B — passed everything applicable but with ONE verification caveat: a skipped
 *       category (no sandbox / remote target), or high-risk tools left
 *       unexercised. Still transactable by default; not payment-eligible.
 *   C — COMPOUNDED caveat: an unambiguously destructive / value-moving tool was
 *       left unexercised AND a category (typically egress) was not verified — a
 *       powerful server we could neither sandbox nor exercise. Refused by default.
 *
 * F is reserved for the two PROVEN, directly-agent-harming failures (injection,
 * leak); the robustness/overreach-class failures (C-02, C-04) cap at D. A skipped
 * category never grants A. The coverage cap (litmus-v16) closes the blind spot
 * where the *most dangerous* tools are silently exempt from every dynamic probe
 * (tool-safety.ts skips state-changing tools from bait calls): their untested-ness
 * now caps the grade instead of passing silently, and the rationale names them.
 * `--allow-state-changing` exercises them, clearing the cap.
 */

import type { CategoryResult, LitmusGrade } from "@polygraph/core";

export interface Grade {
  grade: LitmusGrade;
  rationale: string;
}

/**
 * Dynamic-coverage of the high-risk tool surface, supplied by the harness so the
 * grade can reflect what the probes did NOT exercise (litmus-v16). Optional: a
 * caller that supplies none (or empty lists) gets the pre-v15 behavior, so the
 * rubric truth table and existing callers are unaffected.
 */
export interface GradeCoverage {
  /** High-risk (state-changing) tools not behaviorally exercised — skipped for
   *  safety, no `--allow-state-changing`. Their runtime behavior is unverified. */
  unexercisedHighRiskTools?: readonly string[];
  /** The subset of the above whose NAME carries an unambiguously destructive /
   *  value-moving verb (delete/transfer/send/withdraw/pay/sign/burn/revoke/drop). */
  unexercisedDestructiveTools?: readonly string[];
}

/** Bounded, de-duplicated tool list for a rationale (avoids an unbounded dump). */
function nameList(names: readonly string[]): string {
  const uniq = [...new Set(names)];
  return `${uniq.slice(0, 5).join(", ")}${uniq.length > 5 ? `, +${uniq.length - 5} more` : ""}`;
}

/** Distinct overreach egress hosts from C-02 probe 2.2, in first-seen order. */
function undeclaredEgressHosts(c02: CategoryResult | undefined): string[] {
  const egress = c02?.probes.find((p) => p.id === "2.2");
  const hosts = (egress?.findings ?? [])
    .filter((f) => f.kind === "egress")
    .map((f) => f.host)
    .filter((h): h is string => typeof h === "string" && h.length > 0);
  return [...new Set(hosts)];
}

/**
 * C-02 D-rationale. The egress check is an *overreach* test (litmus-v3): reaching
 * a host the server did not declare is the finding, not proof of malice. So the
 * wording names the undeclared host(s) and points the author at the remedy
 * (`polygraph.egress`) rather than reading as an accusation. Grade is unchanged —
 * still D. Falls back to a generic line when probe detail isn't populated.
 */
function c02FailRationale(c02: CategoryResult | undefined): string {
  const mislabel = c02?.probes.find((p) => p.id === "2.1")?.status === "fail";
  const egress = c02?.probes.find((p) => p.id === "2.2")?.status === "fail";
  const tail = "No injection or data leak, so the grade caps at D.";
  if (egress) {
    const hosts = undeclaredEgressHosts(c02);
    const named =
      hosts.length > 0
        ? `reached ${hosts.length} host(s) it did not declare — ${hosts.slice(0, 5).join(", ")}${hosts.length > 5 ? `, +${hosts.length - 5} more` : ""}. If these are the server's legitimate upstream APIs, the author can declare them in polygraph.egress (package.json) to clear C-02.`
        : "made an outbound attempt to a host outside its declared/baseline allowlist (or with no resolvable host).";
    const mis = mislabel ? " A tool also mislabels its permissions (readOnlyHint)." : "";
    return `Egress overreach (C-02): the server ${named}${mis} ${tail}`;
  }
  if (mislabel) {
    return `Permission mislabel (C-02): a tool claims readOnlyHint:true but its name, a parameter, or its description evidences mutation. ${tail}`;
  }
  return `Egress overreach or permission mislabel (C-02 failed). ${tail}`;
}

export function gradeFromCategories(
  categories: readonly CategoryResult[],
  coverage: GradeCoverage = {},
): Grade {
  const byCode = (code: string) => categories.find((c) => c.code === code);
  const c01 = byCode("C-01");
  const c02 = byCode("C-02");
  const c03 = byCode("C-03");
  const c04 = byCode("C-04");

  const failed = categories.filter((c) => c.status === "fail").map((c) => c.code);
  const skipped = categories.filter((c) => c.status === "skipped").map((c) => c.code);

  const unexercisedHighRisk = coverage.unexercisedHighRiskTools ?? [];
  const unexercisedDestructive = coverage.unexercisedDestructiveTools ?? [];
  const coverageGap = unexercisedHighRisk.length > 0;

  if (c01?.status === "fail" || c03?.status === "fail") {
    return {
      grade: "F",
      rationale: `Disqualifying failure in ${failed.join(", ")} — active injection or data leak harms an agent that trusts this server.`,
    };
  }

  if (c02?.status === "fail" || c04?.status === "fail") {
    return {
      grade: "D",
      rationale:
        c04?.status === "fail" && c02?.status !== "fail"
          ? "Adversarial input handling failed (C-04): the server crashed, leaked internals (a stack trace), or amplified hostile input. No injection or data leak, so the grade caps at D."
          : c02FailRationale(c02),
    };
  }

  const allPass =
    c01?.status === "pass" && c02?.status === "pass" && c03?.status === "pass" && c04?.status === "pass";

  if (allPass) {
    if (!coverageGap) {
      return {
        grade: "A",
        rationale:
          "All four categories passed and the high-risk tool surface was exercised. No injection, no data leak, no egress overreach, and adversarial inputs were handled cleanly (A means no overreach, not no network).",
      };
    }
    // Passed everything applicable (egress WAS verified), but dangerous tools were
    // never behaviorally exercised — their runtime behavior is unproven, so the
    // grade cannot be A. One caveat → B (usable, but not payment-eligible).
    return {
      grade: "B",
      rationale: `All four categories passed, but ${unexercisedHighRisk.length} high-risk tool(s) were not behaviorally exercised (${nameList(unexercisedHighRisk)}) — their runtime behavior is unverified, so the grade caps at B. Re-run with --allow-state-changing to exercise them.`,
    };
  }

  if (c01?.status === "pass") {
    const note = skipped.length
      ? ` Not verified: ${skipped.join(", ")} (${skipped.map((c) => byCode(c)?.reason).filter(Boolean).join("; ")}).`
      : "";
    // COMPOUNDED caveat: an unambiguously destructive / value-moving tool was left
    // unexercised AND a category (typically egress) was not verified. A powerful
    // server we could neither sandbox nor exercise → C, refused by default.
    if (unexercisedDestructive.length > 0) {
      return {
        grade: "C",
        rationale: `Injection checks passed, but ${unexercisedDestructive.length} destructive/value-moving tool(s) were never exercised (${nameList(unexercisedDestructive)}) and a category was not verified — the server's most dangerous behavior is unproven.${note} Grade caps at C. Re-run under a sandbox and with --allow-state-changing to raise it.`,
      };
    }
    const covNote = coverageGap
      ? ` Additionally, ${unexercisedHighRisk.length} high-risk tool(s) were not exercised (${nameList(unexercisedHighRisk)}).`
      : "";
    return {
      grade: "B",
      rationale: `Injection checks passed; egress not verified.${note}${covNote}`,
    };
  }

  // C-01 itself did not produce a pass (e.g. couldn't connect/list tools).
  return {
    grade: "F",
    rationale: "C-01 did not complete — the tool surface could not be evaluated, so the server is treated as ungraded/unsafe.",
  };
}
