import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LoadedSkill } from "./load-skill.js";
import { judgeSkillQuality, openAICompatJudge, judgeFromEnv, type Judge } from "./quality-judge.js";
import { runSkillQuality, runSkillQualityJudged } from "./quality.js";
import { runSkillLitmus } from "./skill-harness.js";

/** A Judge that replays a fixed queue of raw model outputs. */
function queueJudge(responses: string[]): Judge {
  let i = 0;
  return { id: "fake", complete: async () => responses[i++] ?? responses[responses.length - 1] ?? "" };
}
const verdict = (h: string, c: string) => JSON.stringify({ honesty: { rating: h, why: "x" }, coherence: { rating: c, why: "y" } });

const loaded: LoadedSkill = {
  dir: "/tmp/x",
  frontmatter: "name: x\ndescription: formats markdown",
  description: "formats markdown",
  body: "# X\nTidy the markdown.",
  files: [],
  contentHash: "0xabc",
};

describe("judgeSkillQuality — majority over k", () => {
  it("majority-votes per axis and reports agreement", async () => {
    const j = queueJudge([verdict("good", "good"), verdict("good", "concern"), verdict("bad", "good")]);
    const r = await judgeSkillQuality(loaded, j, { samples: 3 });
    expect(r.samples).toBe(3);
    expect(r.axes.find((a) => a.axis === "honesty")?.rating).toBe("good"); // 2/3 good
    expect(r.agreement).toBeCloseTo(0.67, 1); // min axis agreement = 2/3
    expect(r.judge).toBe("fake");
  });

  it("drops unparseable samples and still votes on the rest", async () => {
    const j = queueJudge(["not json at all", "```json\n" + verdict("good", "good") + "\n```"]);
    const r = await judgeSkillQuality(loaded, j, { samples: 2 });
    expect(r.samples).toBe(1); // one parsed
    expect(r.axes.every((a) => a.rating === "good")).toBe(true);
  });

  it("throws when no sample yields a usable verdict", async () => {
    await expect(judgeSkillQuality(loaded, queueJudge(["nope"]), { samples: 1 })).rejects.toThrow();
  });

  it("tie-breaks toward the more cautious rating", async () => {
    const j = queueJudge([verdict("good", "good"), verdict("bad", "good")]); // 1-1 on honesty
    const r = await judgeSkillQuality(loaded, j, { samples: 2 });
    expect(r.axes.find((a) => a.axis === "honesty")?.rating).toBe("bad");
  });
});

describe("openAICompatJudge — provider-agnostic, fetch-based", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  it("posts to <baseUrl>/chat/completions and returns the message content", async () => {
    const spy = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    const out = await openAICompatJudge({ baseUrl: "https://api.example/v1/", apiKey: "k", model: "m" }).complete("sys", "usr");
    expect(out).toBe("hello");
    expect(spy.mock.calls[0]?.[0]).toBe("https://api.example/v1/chat/completions");
  });
  it("throws on a non-ok response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(openAICompatJudge({ baseUrl: "https://x", apiKey: "k", model: "m" }).complete("s", "u")).rejects.toThrow(/HTTP 401/);
  });
});

describe("judgeFromEnv — optional, key-gated", () => {
  it("returns null without a key (the core never requires one)", () => {
    expect(judgeFromEnv({})).toBeNull();
    expect(judgeFromEnv({ LITMUS_LLM_API_KEY: "k" })).toBeNull(); // model required too
  });
  it("builds a judge when key + model are present", () => {
    expect(judgeFromEnv({ LITMUS_LLM_API_KEY: "k", LITMUS_LLM_MODEL: "gpt-4o" })?.id).toBe("openai-compat:gpt-4o");
  });
});

describe("runSkillQualityJudged — composition + separation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-judge-"));
    const p = join(dir, "SKILL.md");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, `---\nname: x\ndescription: formats markdown\n---\n# X\nTidy the markdown.\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const opts = { ranAt: "2026-06-17T00:00:00.000Z" };

  it("attaches judged axes without changing the deterministic verdict", async () => {
    const det = runSkillQuality(dir, opts).verdict;
    const b = await runSkillQualityJudged(dir, queueJudge([verdict("good", "good")]), opts);
    expect(b.verdict).toBe(det); // deterministic verdict untouched
    expect(b.judged?.axes.length).toBe(2);
  });

  it("omits judged axes (no throw) when the judge fails entirely", async () => {
    const b = await runSkillQualityJudged(dir, queueJudge(["garbage"]), opts);
    expect(b.judged).toBeUndefined();
    expect(["well-formed", "issues", "malformed"]).toContain(b.verdict);
  });

  it("never leaks judged data into the safety bundle", () => {
    const safety = JSON.stringify(runSkillLitmus(dir, opts));
    for (const k of ["judged", "honesty", "coherence", "agreement"]) expect(safety).not.toContain(`"${k}"`);
  });
});
