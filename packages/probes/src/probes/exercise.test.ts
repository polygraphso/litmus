import { describe, it, expect } from "vitest";
import { BAIT_POOL, buildBaitArgs, exerciseTool, type ExerciseOutcome } from "./exercise.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("buildBaitArgs", () => {
  const schema = {
    type: "object",
    properties: { text: { type: "string" }, count: { type: "number" }, on: { type: "boolean" } },
    required: ["text", "count", "on"],
  };

  it("fills required fields type-correctly and routes the bait into string fields", () => {
    const args = buildBaitArgs(schema, "the chosen bait");
    expect(args.text).toBe("the chosen bait");
    expect(args.count).toBe(1);
    expect(args.on).toBe(true);
  });

  it("uses a VARIED pool but each member is a valid, deterministic input", () => {
    expect(BAIT_POOL.length).toBeGreaterThan(1);
    expect(new Set(BAIT_POOL).size).toBe(BAIT_POOL.length); // distinct → no single static signature
    for (const bait of BAIT_POOL) expect(buildBaitArgs(schema, bait).text).toBe(bait);
    // none of the bait strings trip the injection scanners (a clean echo must stay clean)
    for (const bait of BAIT_POOL) expect(/ignore|system:|you must/i.test(bait)).toBe(false);
  });
});

describe("exerciseTool", () => {
  const tool = { name: "t", description: "", inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } };
  const clientWith = (callTool: (args: unknown) => Promise<unknown>) => ({ callTool }) as unknown as Client;

  it("returns ok + text on success", async () => {
    const out = await exerciseTool(clientWith(async () => ({ content: [{ type: "text", text: "hello" }] })), tool);
    expect(out.ok).toBe(true);
    expect((out as Extract<ExerciseOutcome, { ok: true }>).text).toContain("hello");
  });

  it("classifies a thrown error (not a silent pass)", async () => {
    const out = await exerciseTool(clientWith(async () => { throw new Error("boom"); }), tool);
    expect(out).toEqual({ ok: false, reason: "error" });
  });

  it("classifies a hang as a timeout", async () => {
    const out = await exerciseTool(clientWith(() => new Promise(() => {})), tool, BAIT_POOL[0], 10);
    expect(out).toEqual({ ok: false, reason: "timeout" });
  });
});
