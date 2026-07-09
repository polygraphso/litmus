import { describe, it, expect } from "vitest";
import { assertEgressRanUnderIsolation, resolveAllowStateChanging } from "./harness.js";
import type { EgressResult } from "./docker/egress-runner.js";

/**
 * The locked "no B-cap under isolation" decision: under
 * isolation:"docker" against a stdio target, the C-02 egress sandbox MUST have
 * run, or the run fails closed. These are pure unit assertions on the extracted
 * guard — the Docker-down and full-flow paths are covered by container-live.
 */

const ran: EgressResult = { ran: true, reason: null, attempts: [], declaredEgress: [], baselineAllowlist: [] };
const didNotRun: EgressResult = { ran: false, reason: "egress sandbox unavailable: boom", attempts: [], declaredEgress: [], baselineAllowlist: [] };

describe("assertEgressRanUnderIsolation — no B-cap fallback under isolation", () => {
  it("throws when isolation is docker, the target is stdio, and egress did not run", () => {
    expect(() => assertEgressRanUnderIsolation(didNotRun, "docker", true)).toThrow(/stdio isolation failed/);
  });

  it("includes the egress reason in the thrown message", () => {
    expect(() => assertEgressRanUnderIsolation(didNotRun, "docker", true)).toThrow(/boom/);
  });

  it("does not throw when egress ran under isolation", () => {
    expect(() => assertEgressRanUnderIsolation(ran, "docker", true)).not.toThrow();
  });

  it("does not throw under isolation:none even if egress did not run (B-cap allowed)", () => {
    expect(() => assertEgressRanUnderIsolation(didNotRun, "none", true)).not.toThrow();
  });

  it("does not throw for an http target under isolation (isolation is stdio-only)", () => {
    expect(() => assertEgressRanUnderIsolation(didNotRun, "docker", false)).not.toThrow();
  });
});

describe("resolveAllowStateChanging — exercise the full surface when it's safe (litmus-v16)", () => {
  it("exercises by default under Docker isolation of a stdio target (no coverage cap)", () => {
    // The load-bearing change: a sandboxed stdio target runs `--network none`, so its
    // state-changing tools are exercised by default → write-capable servers keep A.
    expect(resolveAllowStateChanging(undefined, "docker", true)).toBe(true);
  });

  it("keeps skipping on the host path (isolation none) → the cap can bite there", () => {
    expect(resolveAllowStateChanging(undefined, "none", true)).toBe(false);
  });

  it("keeps skipping for a remote http target (never sandbox-isolated)", () => {
    // A remote target is stdio=false; a call would hit a live backend.
    expect(resolveAllowStateChanging(undefined, "docker", false)).toBe(false);
    expect(resolveAllowStateChanging(undefined, "none", false)).toBe(false);
  });

  it("an explicit --allow-state-changing forces exercise on any path (host escape hatch)", () => {
    expect(resolveAllowStateChanging(true, "none", true)).toBe(true);
    expect(resolveAllowStateChanging(true, "none", false)).toBe(true);
    expect(resolveAllowStateChanging(true, "docker", true)).toBe(true);
  });
});
