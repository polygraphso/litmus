import { describe, it, expect } from "vitest";
import type { EgressResult } from "../docker/egress-runner.js";
import { c02Permission, probe21Declaration } from "./c02-egress.js";

const ran = (attempts: EgressResult["attempts"]): EgressResult => ({ ran: true, reason: null, attempts });
const skipped = (reason: string): EgressResult => ({ ran: false, reason, attempts: [] });
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

  it("pass 2.1 + fail 2.2 (unexpected egress) → C-02 fail", () => {
    const c = c02Permission(pass21, ran([{ kind: "tcp", host: "evil.example", port: 443 }]));
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
