import { describe, it, expect } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDef } from "@polygraph/core";
import { c03Sensitive } from "./c03-sensitive.js";
import type { ProbeContext } from "./context.js";
import type { EgressResult } from "../docker/egress-runner.js";

const NO_EGRESS: EgressResult = { ran: false, reason: "no sandbox", attempts: [], declaredEgress: [], baselineAllowlist: [] };

const TOOLS: ToolDef[] = [{ name: "read_thing", description: "", inputSchema: null }];

function clientReturning(text: string): Client {
  return {
    callTool: async () => ({ content: [{ type: "text", text }] }),
  } as unknown as Client;
}

function baseCtx(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    client: clientReturning("ok"),
    tools: TOOLS,
    canaries: ["CANARY-VALUE"],
    dockerAvailable: false,
    stateChangingTools: new Set(),
    allowStateChanging: false,
    ...overrides,
  };
}

describe("c03Sensitive: remote (no-canary) honesty, litmus-v17", () => {
  it("probe 4.1 is skipped with a plain reason when nothing was planted", async () => {
    const cat = await c03Sensitive(baseCtx({ canaryPlanted: false }), NO_EGRESS);
    const p41 = cat.probes.find((p) => p.id === "4.1")!;
    expect(p41.status).toBe("skipped");
    expect(p41.reason).toBe("no canary could be planted on a remote target");
    expect(p41.findings).toEqual([]);
  });

  it("does not exercise any tool when nothing was planted (nothing to scan for)", async () => {
    let called = false;
    const client = {
      callTool: async () => {
        called = true;
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as Client;
    await c03Sensitive(baseCtx({ client, canaryPlanted: false }), NO_EGRESS);
    expect(called).toBe(false);
  });

  it("category resolves to skipped (never pass) when 4.1 is skipped and nothing else failed", async () => {
    const cat = await c03Sensitive(baseCtx({ canaryPlanted: false }), NO_EGRESS);
    expect(cat.status).toBe("skipped");
    expect(cat.reason).toBe("no canary could be planted on a remote target");
  });

  it("a clean local run (canaryPlanted true, the default) is unaffected: still a real pass", async () => {
    const cat = await c03Sensitive(baseCtx(), NO_EGRESS);
    const p41 = cat.probes.find((p) => p.id === "4.1")!;
    expect(p41.status).toBe("pass");
    expect(cat.status).toBe("pass");
  });

  it("omitting canaryPlanted entirely defaults to true (pre-v17 behavior, unchanged)", async () => {
    const ctx = baseCtx();
    delete (ctx as { canaryPlanted?: boolean }).canaryPlanted;
    const cat = await c03Sensitive(ctx, NO_EGRESS);
    expect(cat.status).toBe("pass");
  });

  it("a genuine canary leak still fails C-03 to F-eligible (fail), even though planted", async () => {
    const client = clientReturning("leaked: CANARY-VALUE right here");
    const cat = await c03Sensitive(baseCtx({ client }), NO_EGRESS);
    const p41 = cat.probes.find((p) => p.id === "4.1")!;
    expect(p41.status).toBe("fail");
    expect(cat.status).toBe("fail");
  });

  it("a leak finding always fails the category, regardless of the plant signal", async () => {
    // canaryPlanted:false short-circuits probe 4.1 before it can find anything,
    // so this only exercises the (already-covered) planted+leak path above;
    // this case documents that fail always wins over skip when both could
    // theoretically apply (probe 4.2, egress leak, still runs independently).
    const egressLeak: EgressResult = {
      ran: true,
      reason: null,
      attempts: [{ kind: "tcp", host: "evil.example", port: 443, firstBytes: "CANARY-VALUE" }],
      declaredEgress: [],
      baselineAllowlist: [],
    };
    const cat = await c03Sensitive(baseCtx({ canaryPlanted: false }), egressLeak);
    expect(cat.status).toBe("fail");
  });
});
