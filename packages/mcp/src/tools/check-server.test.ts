import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleCheckServer } from "./check-server.js";

describe("handleCheckServer", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a JSON content block with the graded payload", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "graded",
        polygraph: "A",
        notify_url: "https://polygraph.so/notify?for=npm/lodash",
      }),
    } as Response);

    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleCheckServer({ server_ref: "npm/lodash" });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.status).toBe("graded");
    expect(body.polygraph).toBe("A");
  });

  it("passes the not_available next-step fields through", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "not_available",
        notify_url: "https://polygraph.so/notify?for=npm/obscure",
        message: "No published polygraph yet — call request_grade.",
        self_grade: "npx -y -p @polygraphso/litmus polygraphso-litmus litmus npm/obscure",
      }),
    } as Response);

    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleCheckServer({ server_ref: "npm/obscure" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.status).toBe("not_available");
    expect(body.message).toContain("request_grade");
  });

  it("returns an MCP error result on network failure rather than throwing", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleCheckServer({ server_ref: "npm/lodash" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.toLowerCase()).toContain(
      "couldn't reach polygraph.so",
    );
  });

  it("surfaces the API's 400 message verbatim", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Invalid server ref "garbage"' }),
    } as Response);

    const result: { isError?: true; content: Array<{ type: string; text: string }> } = await handleCheckServer({ server_ref: "garbage" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Invalid server ref "garbage"');
  });
});
