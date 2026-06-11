import { describe, it, expect } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDef } from "@polygraph/core";
import { c01Injection } from "./c01-injection.js";
import { c03Sensitive } from "./c03-sensitive.js";
import type { ProbeContext } from "./context.js";
import type { EgressResult } from "../docker/egress-runner.js";

const NO_EGRESS: EgressResult = { ran: false, reason: "no sandbox", attempts: [] };

/** A client that records the names of the tools it was asked to call. */
function recordingClient(calls: string[]): Client {
  return {
    callTool: async ({ name }: { name: string }) => {
      calls.push(name);
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as Client;
}

const TOOLS: ToolDef[] = [
  { name: "read_graph", description: "", inputSchema: null },
  { name: "send", description: "", inputSchema: null },
];

function makeCtx(calls: string[], allowStateChanging: boolean): ProbeContext {
  return {
    client: recordingClient(calls),
    tools: TOOLS,
    canaries: ["CANARY"],
    dockerAvailable: false,
    stateChangingTools: new Set(["send"]),
    allowStateChanging,
  };
}

describe("dynamic probes skip state-changing tools by default", () => {
  it("C-01 1.2 does not bait-call `send`, but does call read-only tools", async () => {
    const calls: string[] = [];
    const cat = await c01Injection(makeCtx(calls, false));
    expect(calls).not.toContain("send");
    expect(calls).toContain("read_graph");
    const p12 = cat.probes.find((p) => p.id === "1.2")!;
    expect(p12.reason).toMatch(/skipped \(state-changing.*--allow-state-changing\): send/);
  });

  it("C-03 4.1 does not bait-call `send` by default", async () => {
    const calls: string[] = [];
    const cat = await c03Sensitive(makeCtx(calls, false), NO_EGRESS);
    expect(calls).not.toContain("send");
    expect(calls).toContain("read_graph");
    const p41 = cat.probes.find((p) => p.id === "4.1")!;
    expect(p41.reason).toMatch(/skipped \(state-changing.*\): send/);
  });

  it("--allow-state-changing exercises every tool, including `send`", async () => {
    const calls: string[] = [];
    await c01Injection(makeCtx(calls, true));
    expect(calls).toContain("send");
  });
});
