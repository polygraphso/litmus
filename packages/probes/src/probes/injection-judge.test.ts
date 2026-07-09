import { describe, it, expect } from "vitest";
import type { ToolDef } from "@polygraph/core";
import { judgeInjection } from "./injection-judge.js";
import type { Judge } from "../skills/quality-judge.js";

/** A fake judge returning a fixed sequence of completions (cycled). */
function fakeJudge(replies: string[], id = "fake"): Judge {
  let i = 0;
  return { id, complete: async () => replies[i++ % replies.length]! };
}

const TOOLS: ToolDef[] = [
  { name: "get_weather", description: "Get the weather for a city.", inputSchema: { type: "object", properties: { city: { type: "string" } } } },
];

const CLEAN = '{"agent-directed-instruction":{"rating":"good","why":"honest"},"covert-exfil":{"rating":"good","why":"none"}}';
const POISON = '{"agent-directed-instruction":{"rating":"bad","why":"reads a secret file"},"covert-exfil":{"rating":"concern","why":"sends notes out"}}';

describe("judgeInjection (advisory, litmus-v16)", () => {
  it("returns per-axis ratings, the judge id, and an advisory note", async () => {
    const r = await judgeInjection(TOOLS, fakeJudge([CLEAN], "openai-compat:test"));
    expect(r.judge).toBe("openai-compat:test");
    expect(r.axes.map((a) => a.axis)).toEqual(["agent-directed-instruction", "covert-exfil"]);
    expect(r.axes.every((a) => a.rating === "good")).toBe(true);
    expect(r.note).toMatch(/never affects the A–F grade/i);
  });

  it("surfaces a bad/concern verdict for a poisoned surface", async () => {
    const r = await judgeInjection(TOOLS, fakeJudge([POISON]));
    expect(r.axes.find((a) => a.axis === "agent-directed-instruction")?.rating).toBe("bad");
    expect(r.axes.find((a) => a.axis === "covert-exfil")?.rating).toBe("concern");
  });

  it("majority-votes over k samples and reports the agreement ratio", async () => {
    // 3 samples: bad, bad, good on axis 1 → majority bad at 2/3 agreement.
    const r = await judgeInjection(TOOLS, fakeJudge([POISON, POISON, CLEAN]), { samples: 3 });
    expect(r.samples).toBe(3);
    expect(r.axes.find((a) => a.axis === "agent-directed-instruction")?.rating).toBe("bad");
    expect(r.agreement).toBeCloseTo(2 / 3, 2);
  });

  it("throws when no sample yields a parseable verdict (caller treats as 'not run')", async () => {
    await expect(judgeInjection(TOOLS, fakeJudge(["not json", "still not json"]))).rejects.toThrow();
  });
});
