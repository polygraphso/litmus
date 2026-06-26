import { describe, it, expect, beforeAll } from "vitest";
import { parseCiArgs, evaluate, resolveSpecs, renderSummary, type Grader } from "./ci.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

// `runCi` calls emitGitHub, which appends to $GITHUB_STEP_SUMMARY / $GITHUB_OUTPUT and
// writes ::error:: lines when those CI env vars are set. Under GITHUB_ACTIONS that would
// leak an empty "Polygraph gate" table into the real job summary. These tests assert exit
// codes, not CI side effects — so suppress the GitHub env here.
beforeAll(() => {
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_STEP_SUMMARY;
});

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
    expect(specs).toEqual([{ kind: "server", display: "npm/@a/b", ref: "npm/@a/b" }]);
  });
  it("dedupes a repeated explicit server", () => {
    const specs = resolveSpecs({ servers: ["npm/@a/b", "npm/@a/b"], discover: false, cwd: ".", strict: false, lookup: true, json: false });
    expect(specs).toHaveLength(1);
  });
  it("discovers skills under cwd when discover is on", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "ci-rs-skill-"));
    try {
      mkdirSync(nodePath.join(root, "myskill"));
      writeFileSync(nodePath.join(root, "myskill/SKILL.md"), "# x");
      const specs = resolveSpecs({ servers: [], skills: [], discover: true, cwd: root, strict: false, lookup: true, json: false });
      const skill = specs.find((s) => s.kind === "skill");
      expect(skill?.name).toBe("myskill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evaluate — with an injected grader", () => {
  const fake = (table: Record<string, "A" | "B" | "C" | "D" | "F" | null>): Grader =>
    async (spec) => {
      const g = spec.ref ? table[spec.ref] ?? null : null;
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

  it("a throwing grader degrades to ungradeable without aborting the run", async () => {
    const throwingThenOk: Grader = async (spec) => {
      if (spec.ref === "npm/@boom/x") throw new Error("network blip");
      return { grade: "A", source: "live" };
    };
    const results = await evaluate(
      { servers: ["npm/@boom/x", "npm/@ok/y"], discover: false, cwd: ".", strict: false, lookup: true, json: false },
      throwingThenOk,
    );
    expect(results.find((r) => r.display === "npm/@boom/x")?.source).toBe("ungradeable");
    expect(results.find((r) => r.display === "npm/@ok/y")?.grade).toBe("A");
  });
});

describe("renderSummary", () => {
  it("includes a row per target with grade and verdict", () => {
    const md = renderSummary([
      { kind: "server", display: "npm/@a/b", grade: "F", source: "live", gated: true, reason: "below the minimum C" },
      { kind: "server", display: "npm/@c/d", grade: "A", source: "published", gated: false, reason: "meets the bar" },
    ]);
    expect(md).toContain("npm/@a/b");
    expect(md).toContain("F");
    expect(md).toContain("npm/@c/d");
    expect(md).toContain("Kind");
    expect(md).toContain("server");
  });
});

import { runCi } from "./ci.js";

describe("runCi exit code", () => {
  it("returns 0 when nothing is gated (no targets, no discovery)", async () => {
    const code = await runCi(["--no-discover", "--no-lookup"]);
    expect(code).toBe(0);
  });
});

describe("runCi --help", () => {
  it("prints help and exits 0 without running a gate", async () => {
    expect(await runCi(["--help"])).toBe(0);
  });
});

describe("parseCiArgs — skills", () => {
  it("parses repeated --skill into skills", () => {
    expect(parseCiArgs(["--skill", "./a", "--skill", "./b"]).skills).toEqual(["./a", "./b"]);
  });
});

describe("evaluate — mixed server + skill kinds", () => {
  const kindFake = (table: Record<string, "A" | "B" | "D" | "F" | null>): Grader =>
    async (spec) => {
      const g = spec.ref ? table[spec.ref] ?? null : null;
      return { grade: g, source: g === null ? "ungradeable" : "live" };
    };
  it("grades a server and a skill in one run, gating the failing one", async () => {
    const results = await evaluate(
      { servers: ["npm/@ok/srv"], skills: ["/skills/bad"], discover: false, cwd: ".", strict: false, lookup: false, json: false },
      kindFake({ "npm/@ok/srv": "A", "/skills/bad": "F" }),
    );
    const srv = results.find((r) => r.display === "npm/@ok/srv");
    const skill = results.find((r) => r.display === "/skills/bad");
    expect(srv?.kind).toBe("server");
    expect(srv?.gated).toBe(false);
    expect(skill?.kind).toBe("skill");
    expect(skill?.gated).toBe(true);
  });
});
