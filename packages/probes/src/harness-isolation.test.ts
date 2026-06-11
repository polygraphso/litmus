import { describe, it, expect } from "vitest";
import { assertEgressRanUnderIsolation } from "./harness.js";
import type { EgressResult } from "./docker/egress-runner.js";

/**
 * The locked "no B-cap under isolation" decision (plan §0): under
 * isolation:"docker" against a stdio target, the C-02 egress sandbox MUST have
 * run, or the run fails closed. These are pure unit assertions on the extracted
 * guard — the Docker-down and full-flow paths are covered by container-live.
 */

const ran: EgressResult = { ran: true, reason: null, attempts: [] };
const didNotRun: EgressResult = { ran: false, reason: "egress sandbox unavailable: boom", attempts: [] };

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
