/**
 * Pure gate policy for `polygraphso ci`. Maps a grade (or "could not grade") to a
 * pass/fail decision. Default: fail on D/F. `minGrade` raises the bar; `strict`
 * turns un-gradeable deps into failures instead of warnings.
 */
import type { LitmusGrade } from "@polygraph/core";

export type GradeSource = "published" | "live" | "ungradeable";

export const GRADE_ORDER: readonly LitmusGrade[] = ["A", "B", "C", "D", "F"];

/** Rank A=0 (best) … F=4 (worst). Higher is worse. */
export function gradeRank(g: LitmusGrade): number {
  const rank = GRADE_ORDER.indexOf(g);
  if (rank === -1) throw new Error(`Unknown grade: ${g}`);
  return rank;
}

export interface GateInput {
  grade: LitmusGrade | null;
  source: GradeSource;
}
export interface GateOptions {
  minGrade?: LitmusGrade;
  strict?: boolean;
}
export interface GateResult {
  gated: boolean;
  reason: string;
}

export function gate(input: GateInput, opts: GateOptions = {}): GateResult {
  if (input.grade === null) {
    return opts.strict
      ? { gated: true, reason: "could not be graded (strict mode)" }
      : { gated: false, reason: "could not be graded — warning only" };
  }
  // Default minimum is C, so anything worse (D, F) fails — the D/F gate.
  const min: LitmusGrade = opts.minGrade ?? "C";
  const gated = gradeRank(input.grade) > gradeRank(min);
  return {
    gated,
    reason: gated ? `grade ${input.grade} is below the minimum ${min}` : `grade ${input.grade} meets the bar`,
  };
}
