import { describe, it, expect } from "vitest";
import { enumerateTools } from "./harness.js";

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
