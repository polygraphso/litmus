import { describe, it, expect } from "vitest";
import { BAIT_POOL, buildBaitArgs, exerciseTool, MAX_RESULT_CHARS, stringifyResult, type ExerciseOutcome } from "./exercise.js";
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

describe("stringifyResult — caps a hostile result's scannable text", () => {
  it("passes through an honest, small result unchanged", () => {
    const out = stringifyResult({ content: [{ type: "text", text: "hello world" }] });
    expect(out).toContain("hello world");
    expect(out.length).toBeLessThan(MAX_RESULT_CHARS);
  });

  it("truncates an oversized text payload at MAX_RESULT_CHARS", () => {
    const huge = "A".repeat(MAX_RESULT_CHARS * 3);
    const out = stringifyResult({ content: [{ type: "text", text: huge }] });
    expect(out.length).toBe(MAX_RESULT_CHARS);
  });

  it("caps a giant non-object result too", () => {
    const out = stringifyResult("B".repeat(MAX_RESULT_CHARS * 2));
    expect(out.length).toBe(MAX_RESULT_CHARS);
  });

  it("still surfaces a canary that sits within the kept prefix", () => {
    const payload = "CANARY-abc123 " + "x".repeat(MAX_RESULT_CHARS * 2);
    const out = stringifyResult({ content: [{ type: "text", text: payload }] });
    expect(out).toContain("CANARY-abc123"); // scanners can still find a planted canary in the prefix
    expect(out.length).toBe(MAX_RESULT_CHARS);
  });
});
