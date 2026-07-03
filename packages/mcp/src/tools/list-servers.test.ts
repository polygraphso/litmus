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

  it("returns an MCP error result on network failure rather than throwing", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleListServers();
    expect(result.isError).toBe(true);
  });
});
