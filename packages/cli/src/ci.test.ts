import { describe, it, expect } from "vitest";
import { parseCiArgs, evaluate, resolveSpecs, renderSummary, type Grader } from "./ci.js";

describe("parseCiArgs", () => {
  it("parses flags, repeated --server, and positionals", () => {
    const o = parseCiArgs(["--strict", "--min-grade", "B", "--no-discover", "--no-lookup",
      "--server", "npm/@a/b", "--bearer", "tok", "npm/@c/d"]);
    expect(o.strict).toBe(true);
    expect(o.minGrade).toBe("B");
    expect(o.discover).toBe(false);
    expect(o.lookup).toBe(false);
    expect(o.bearer).toBe("tok");
    expect(o.servers).toEqual(["npm/@a/b", "npm/@c/d"]);
  });
  it("defaults: discover on, lookup on, not strict", () => {
    const o = parseCiArgs([]);
    expect(o.discover).toBe(true);
    expect(o.lookup).toBe(true);
    expect(o.strict).toBe(false);
    expect(o.minGrade).toBeUndefined();
  });
});

describe("resolveSpecs", () => {
  it("merges explicit + discovered and dedupes by ref", () => {
    const specs = resolveSpecs({ servers: ["npm/@a/b"], discover: false, cwd: ".", strict: false, lookup: true, json: false });
    expect(specs).toEqual([{ display: "npm/@a/b", ref: "npm/@a/b" }]);
  });
});

describe("evaluate — with an injected grader", () => {
  const fake = (table: Record<string, "A" | "B" | "C" | "D" | "F" | null>): Grader =>
    async (ref) => {
      const g = ref ? table[ref] ?? null : null;
      return { grade: g, source: g === null ? "ungradeable" : "live" };
    };

  it("gates D/F and passes A/B; returns one result per target", async () => {
    const results = await evaluate(
      { servers: ["npm/@bad/x", "npm/@ok/y"], discover: false, cwd: ".", strict: false, lookup: true, json: false },
      fake({ "npm/@bad/x": "F", "npm/@ok/y": "A" }),
    );
    expect(results.find((r) => r.display === "npm/@bad/x")?.gated).toBe(true);
    expect(results.find((r) => r.display === "npm/@ok/y")?.gated).toBe(false);
  });

  it("un-gradeable warns by default, fails under strict", async () => {
    const base = { servers: ["npm/@u/x"], discover: false, cwd: ".", lookup: true, json: false };
    const warn = await evaluate({ ...base, strict: false }, fake({ "npm/@u/x": null }));
    expect(warn[0]!.gated).toBe(false);
    const strict = await evaluate({ ...base, strict: true }, fake({ "npm/@u/x": null }));
    expect(strict[0]!.gated).toBe(true);
  });
});

describe("renderSummary", () => {
  it("includes a row per target with grade and verdict", () => {
    const md = renderSummary([
      { display: "npm/@a/b", grade: "F", source: "live", gated: true, reason: "below the minimum C" },
      { display: "npm/@c/d", grade: "A", source: "published", gated: false, reason: "meets the bar" },
    ]);
    expect(md).toContain("npm/@a/b");
    expect(md).toContain("F");
    expect(md).toContain("npm/@c/d");
  });
});
