import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleRequestGrade } from "./request-grade.js";

describe("handleRequestGrade", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queues the request and forwards the caller's agent id", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "queued", created: true, demand: 1 }),
    } as Response);

    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleRequestGrade({ server_ref: "npm/foo-mcp" }, "claude-ai/1.2.0");

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("Queued npm/foo-mcp");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      server_ref: "npm/foo-mcp",
      source: "mcp",
      agent_id: "claude-ai/1.2.0",
    });
  });

  it("works without a known agent id and reports an already-queued target", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "queued", created: false, demand: 4 }),
    } as Response);

    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleRequestGrade({ server_ref: "npm/foo-mcp" });

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("already in the queue");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      server_ref: "npm/foo-mcp",
      source: "mcp",
    });
  });

  it("returns an MCP error result on network failure rather than throwing", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleRequestGrade({ server_ref: "npm/foo-mcp" });
    expect(result.isError).toBe(true);
  });
});
