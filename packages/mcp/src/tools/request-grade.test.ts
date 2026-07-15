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

  it("records the request, surfaces the payment link, and forwards the caller's agent id", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "queued",
        created: true,
        demand: 1,
        requestId: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
        payment: {
          required: true,
          usdPrice: 1,
          payUrl: "https://www.polygraph.so/request/priority/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
          x402Url: "https://www.polygraph.so/api/x402/grade-request",
        },
      }),
    } as Response);

    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleRequestGrade({ server_ref: "npm/foo-mcp" }, { agentId: "claude-ai/1.2.0" });

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Recorded npm/foo-mcp");
    expect(text).toContain("$1 fee is paid");
    expect(text).toContain("https://www.polygraph.so/request/priority/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b");
    expect(text).toContain("https://www.polygraph.so/api/x402/grade-request");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      server_ref: "npm/foo-mcp",
      source: "mcp",
      agent_id: "claude-ai/1.2.0",
    });
  });

  it("reports an already-recorded, already-paid target without a payment ask", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "queued",
        created: false,
        demand: 4,
        requestId: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
        payment: { required: false, usdPrice: 1, payUrl: null, x402Url: "https://www.polygraph.so/api/x402/grade-request" },
      }),
    } as Response);

    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleRequestGrade({ server_ref: "npm/foo-mcp" });

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("already recorded");
    expect(text).toContain("already paid");
    expect(text).not.toContain("Pay at");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      server_ref: "npm/foo-mcp",
      source: "mcp",
    });
  });

  it("keeps working against an older deployment that sends no payment info", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "queued", created: true, demand: 1 }),
    } as Response);

    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleRequestGrade({ server_ref: "npm/foo-mcp" });

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("best-effort");
  });

  it("returns an MCP error result on network failure rather than throwing", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleRequestGrade({ server_ref: "npm/foo-mcp" });
    expect(result.isError).toBe(true);
  });
});
