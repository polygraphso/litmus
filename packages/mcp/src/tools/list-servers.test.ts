import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleListServers } from "./list-servers.js";

describe("handleListServers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the graded-server index as JSON", async () => {
    const payload = {
      servers: [{ server_ref: "npm/@modelcontextprotocol/server-filesystem", polygraph: "A" }],
      total: 1,
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response);

    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleListServers();
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(payload);
  });

  it("defaults to limit=25 when no args are passed", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ servers: [], total: 0 }),
    } as Response);

    await handleListServers();
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(new URL(url).searchParams.get("limit")).toBe("25");
  });

  it("forwards grade and limit as query params", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ servers: [], total: 0 }),
    } as Response);

    await handleListServers({ grade: "A", limit: 5 });
    const url = fetchMock.mock.calls[0]![0] as string;
    const params = new URL(url).searchParams;
    expect(params.get("grade")).toBe("A");
    expect(params.get("limit")).toBe("5");
  });

  it("trims client-side and notes it when the index ignores limit", async () => {
    const servers = Array.from({ length: 30 }, (_, i) => ({
      server_ref: `npm/pkg-${i}`,
      polygraph: "A" as const,
    }));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ servers, total: 30 }),
    } as Response);

    const result: { content: Array<{ type: string; text: string }> } = await handleListServers({ limit: 5 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("showing 5 of 30");
    const jsonPart = text.slice(0, text.lastIndexOf("\nshowing"));
    const parsed = JSON.parse(jsonPart) as { servers: unknown[] };
    expect(parsed.servers).toHaveLength(5);
  });

  it("returns an MCP error result on network failure rather than throwing", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleListServers();
    expect(result.isError).toBe(true);
  });
});
