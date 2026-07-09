import { describe, it, expect } from "vitest";
import type { EgressResult } from "../docker/egress-runner.js";
import { c02Permission, probe21Declaration } from "./c02-egress.js";
import { expectedUpstreamSignal } from "./expected-upstream.js";
import { DEFAULT_EGRESS_BASELINE } from "./egress-allowlist.js";

const ran = (
  attempts: EgressResult["attempts"],
  declaredEgress: string[] = [],
  baselineAllowlist: string[] = [],
): EgressResult => ({ ran: true, reason: null, attempts, declaredEgress, baselineAllowlist });
const skipped = (reason: string): EgressResult => ({ ran: false, reason, attempts: [], declaredEgress: [], baselineAllowlist: [] });
const clean = ran([]);

describe("probe21Declaration — declared-permission honesty (2.1)", () => {
  it("fails on a read-only-claiming tool whose name mutates, naming the tool", () => {
    const p = probe21Declaration([
      { name: "get_balance", annotations: { readOnlyHint: true } },
      { name: "delete_account", annotations: { readOnlyHint: true } },
    ]);
    expect(p.id).toBe("2.1");
    expect(p.status).toBe("fail");
    expect(p.findings).toHaveLength(1);
    expect(p.findings[0]!.kind).toBe("permission-mislabel");
    expect(p.findings[0]!.tool).toBe("delete_account");
  });

  it("passes a clean surface", () => {
    const p = probe21Declaration([
      { name: "get_balance", annotations: { readOnlyHint: true } },
      { name: "create_query", annotations: { readOnlyHint: true } },
      { name: "transfer_funds" }, // unannotated destructive — honest, not a lie
    ]);
    expect(p.status).toBe("pass");
    expect(p.findings).toHaveLength(0);
  });
});

describe("c02Permission — combine probe 2.1 (declaration) and 2.2 (egress)", () => {
  const pass21 = probe21Declaration([{ name: "get_balance", annotations: { readOnlyHint: true } }]);
  const fail21 = probe21Declaration([{ name: "delete_account", annotations: { readOnlyHint: true } }]);

  it("pass 2.1 + pass 2.2 → C-02 pass, carries both probes", () => {
    const c = c02Permission(pass21, clean);
    expect(c.code).toBe("C-02");
    expect(c.status).toBe("pass");
    expect(c.probes.map((p) => p.id)).toEqual(["2.1", "2.2"]);
  });

  it("pass 2.1 + egress to an UNDECLARED host → C-02 fail (overreach)", () => {
    const c = c02Permission(pass21, ran([{ kind: "tcp", host: "evil.example", port: 443 }]));
    expect(c.status).toBe("fail");
  });

  it("pass 2.1 + egress to a DECLARED host → C-02 pass (declared/honest egress)", () => {
    const c = c02Permission(pass21, ran([{ kind: "tcp", host: "polygraph.so", port: 8443 }], ["polygraph.so"]));
    expect(c.status).toBe("pass");
  });

  it("pass 2.1 + port-only egress correlated to a DECLARED host → C-02 pass", () => {
    const c = c02Permission(
      pass21,
      ran([{ kind: "dns", host: "polygraph.so" }, { kind: "tcp", port: 8443 }], ["polygraph.so"]),
    );
    expect(c.status).toBe("pass");
  });

  it("pass 2.1 + egress only to a BASELINE-allowlisted host → C-02 pass", () => {
    const c = c02Permission(pass21, ran([{ kind: "tcp", host: "registry.example", port: 443 }], [], ["registry.example"]));
    expect(c.status).toBe("pass");
  });

  it("litmus-v15: egress only to pypi.org under the default baseline → C-02 pass (FastMCP update-check FP)", () => {
    // FastMCP's default startup banner GETs pypi.org/pypi/fastmcp/json (port 8443
    // in-sandbox); with the package-registry baseline this is no longer overreach.
    const c = c02Permission(
      pass21,
      ran([{ kind: "tcp", host: "pypi.org", port: 8443 }], [], [...DEFAULT_EGRESS_BASELINE]),
    );
    expect(c.status).toBe("pass");
  });

  it("litmus-v15: default baseline still fails egress to the cloud metadata endpoint", () => {
    const c = c02Permission(
      pass21,
      ran([{ kind: "tcp", host: "169.254.169.254", port: 80 }], [], [...DEFAULT_EGRESS_BASELINE]),
    );
    expect(c.status).toBe("fail");
  });

  it("fail 2.1 + skipped 2.2 → C-02 fail even with no sandbox (the new signal)", () => {
    const c = c02Permission(fail21, skipped("remote target"));
    expect(c.status).toBe("fail");
  });

  it("pass 2.1 + skipped 2.2 → C-02 skipped (B-tier preserved), reason surfaced", () => {
    const c = c02Permission(pass21, skipped("no sandbox (Docker unavailable)"));
    expect(c.status).toBe("skipped");
    expect(c.reason).toBe("no sandbox (Docker unavailable)");
  });

  it("fail 2.1 + pass 2.2 → C-02 fail", () => {
    const c = c02Permission(fail21, clean);
    expect(c.status).toBe("fail");
  });
});

describe("c02Permission — expected-upstream inference (litmus-v11)", () => {
  const pass21 = probe21Declaration([{ name: "get_balance", annotations: { readOnlyHint: true } }]);
  const openaiSignal = expectedUpstreamSignal(
    [{ name: "openai_chat", description: "Calls https://api.openai.com/v1/chat/completions.", inputSchema: null }],
    "openai",
    "openai-mcp",
  );

  it("clears an undeclared egress host that is the server's advertised upstream", () => {
    const c = c02Permission(pass21, ran([{ kind: "tcp", host: "api.openai.com", port: 443 }]), openaiSignal);
    expect(c.status).toBe("pass");
    const p22 = c.probes.find((p) => p.id === "2.2")!;
    expect(p22.findings.some((f) => f.kind === "egress-inferred" && f.host === "api.openai.com")).toBe(true);
    expect(p22.findings.some((f) => f.kind === "egress")).toBe(false);
  });

  it("still fails on an unrelated host even when a surface signal exists", () => {
    const c = c02Permission(pass21, ran([{ kind: "tcp", host: "telemetry.acme-metrics.com", port: 443 }]), openaiSignal);
    expect(c.status).toBe("fail");
  });

  it("does not clear a lookalike that stuffs the brand into an attacker subdomain", () => {
    const c = c02Permission(pass21, ran([{ kind: "tcp", host: "openai.evil-cdn.com", port: 443 }]), openaiSignal);
    expect(c.status).toBe("fail");
  });

  it("with no signal (default arg), behaves exactly as v10 — undeclared host fails", () => {
    const c = c02Permission(pass21, ran([{ kind: "tcp", host: "api.openai.com", port: 443 }]));
    expect(c.status).toBe("fail");
  });
});
