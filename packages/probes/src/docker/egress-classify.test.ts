import { describe, it, expect } from "vitest";
import { correlateEgress, classifyEgress, type EgressAttempt } from "./egress-runner.js";

describe("correlateEgress", () => {
  it("correlates a port-only TCP attempt to the preceding DNS lookup's host", () => {
    const attempts: EgressAttempt[] = [
      { kind: "dns", host: "polygraph.so" },
      { kind: "tcp", port: 8443 },
    ];
    const out = correlateEgress(attempts);
    expect(out).toEqual([
      { kind: "dns", host: "polygraph.so", hostSource: "given" },
      { kind: "tcp", host: "polygraph.so", port: 8443, hostSource: "dns-correlation" },
    ]);
  });

  it("keeps a sniffed host on the TCP attempt (no correlation needed)", () => {
    const out = correlateEgress([{ kind: "tcp", host: "api.openai.com", port: 443 }]);
    expect(out[0]).toMatchObject({ kind: "tcp", host: "api.openai.com", port: 443, hostSource: "given" });
  });

  it("leaves host undefined when a TCP attempt has no host and no preceding DNS", () => {
    const out = correlateEgress([{ kind: "tcp", port: 9999 }]);
    expect(out[0]).toMatchObject({ kind: "tcp", port: 9999, hostSource: "none" });
    expect(out[0]!.host).toBeUndefined();
  });
});

describe("classifyEgress", () => {
  const allow = ["polygraph.so", "*.openai.com"];

  it("marks egress to an allowlisted host as allowed (with the matched pattern)", () => {
    const c = classifyEgress(correlateEgress([{ kind: "dns", host: "polygraph.so" }, { kind: "tcp", port: 8443 }]), allow);
    expect(c.every((x) => x.allowed)).toBe(true);
    expect(c[1]).toMatchObject({ host: "polygraph.so", allowed: true, matchedPattern: "polygraph.so" });
  });

  it("marks egress to an undeclared host as overreach", () => {
    const c = classifyEgress(correlateEgress([{ kind: "tcp", host: "evil.com", port: 443 }]), allow);
    expect(c[0]).toMatchObject({ host: "evil.com", allowed: false });
  });

  it("treats an uncorrelatable port-only attempt as overreach (conservative)", () => {
    const c = classifyEgress(correlateEgress([{ kind: "tcp", port: 9999 }]), allow);
    expect(c[0]!.allowed).toBe(false);
  });

  it("matches wildcard patterns", () => {
    const c = classifyEgress([{ kind: "tcp", host: "a.openai.com", port: 443, hostSource: "given" }], allow);
    expect(c[0]!.allowed).toBe(true);
  });
});
