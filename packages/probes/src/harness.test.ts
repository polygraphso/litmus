import { describe, it, expect } from "vitest";
import { enumerateTools, buildSurfaceDriftFinding } from "./harness.js";

/** A fake MCP client that serves a fixed list of `tools/list` pages and records cursors. */
function pagedClient(pages: Array<{ tools: Array<{ name: string }>; nextCursor?: string }>) {
  const cursors: Array<string | undefined> = [];
  let i = 0;
  return {
    cursors,
    async listTools(params?: { cursor?: string }) {
      cursors.push(params?.cursor);
      return pages[i++] ?? { tools: [] };
    },
  };
}

describe("enumerateTools — follows tools/list pagination (nextCursor)", () => {
  it("returns a single page unchanged when there is no nextCursor", async () => {
    const c = pagedClient([{ tools: [{ name: "a" }, { name: "b" }] }]);
    const tools = await enumerateTools(c);
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(c.cursors).toEqual([undefined]); // one call, no cursor
  });

  it("accumulates every page in order, threading the cursor back", async () => {
    const c = pagedClient([
      { tools: [{ name: "page1" }], nextCursor: "c1" },
      { tools: [{ name: "page2_hidden" }], nextCursor: "c2" },
      { tools: [{ name: "page3" }] },
    ]);
    const tools = await enumerateTools(c);
    expect(tools.map((t) => t.name)).toEqual(["page1", "page2_hidden", "page3"]);
    expect(c.cursors).toEqual([undefined, "c1", "c2"]); // each page fetched with the prior cursor
  });

  it("fails closed when a server paginates past the gradable cap (no partial grade)", async () => {
    // Every page advertises another page → unbounded. Must refuse, not loop or
    // silently grade the first N tools.
    const infinite = {
      async listTools() {
        return { tools: [{ name: "t" }], nextCursor: "more" };
      },
    };
    await expect(enumerateTools(infinite, { maxTools: 3 })).rejects.toThrow(/refus|exceed|bound/i);
  });
});

describe("buildSurfaceDriftFinding: same-session surface-consistency advisory (litmus-v17)", () => {
  const GRADED = "0x" + "ab".repeat(32);
  const SAME = "0x" + "ab".repeat(32);
  const OTHER = "0x" + "cd".repeat(32);

  it("returns undefined when the recheck fingerprint matches the graded one", () => {
    expect(buildSurfaceDriftFinding(GRADED, { fingerprint: SAME })).toBeUndefined();
  });

  it("returns a surface-drift disclosure finding on a fingerprint mismatch", () => {
    const finding = buildSurfaceDriftFinding(GRADED, { fingerprint: OTHER });
    expect(finding?.kind).toBe("surface-drift");
    expect(finding?.severity).toBe("medium");
    expect(finding?.context).toContain(`graded=${GRADED}`);
    expect(finding?.context).toContain(`recheck=${OTHER}`);
  });

  it("returns a surface-drift finding (never throws) when the recheck connection failed", () => {
    const finding = buildSurfaceDriftFinding(GRADED, { fingerprint: null, error: "connect ECONNREFUSED" });
    expect(finding?.kind).toBe("surface-drift");
    expect(finding?.context).toContain("recheck-error=connect ECONNREFUSED");
  });

  it("a null recheck fingerprint with no error is treated as no finding (defensive default)", () => {
    expect(buildSurfaceDriftFinding(GRADED, { fingerprint: null })).toBeUndefined();
  });
});
