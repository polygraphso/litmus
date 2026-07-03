import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PolygraphApiError,
  lookupApiBaseUrl,
  getList,
  postCheck,
  postGradeRequest,
} from "./api.js";

describe("lookupApiBaseUrl", () => {
  const prev = process.env.POLYGRAPH_API_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.POLYGRAPH_API_URL;
    else process.env.POLYGRAPH_API_URL = prev;
  });

  it("defaults to https://polygraph.so", () => {
    delete process.env.POLYGRAPH_API_URL;
    expect(lookupApiBaseUrl()).toBe("https://polygraph.so");
  });

  it("respects an override and strips trailing slashes", () => {
    process.env.POLYGRAPH_API_URL = "https://staging.polygraph.so///";
    expect(lookupApiBaseUrl()).toBe("https://staging.polygraph.so");
  });

  it("allows plaintext http only for loopback dev servers", () => {
    process.env.POLYGRAPH_API_URL = "http://localhost:3000";
    expect(lookupApiBaseUrl()).toBe("http://localhost:3000");
  });

  it("rejects plaintext http for non-loopback hosts", () => {
    process.env.POLYGRAPH_API_URL = "http://polygraph.example.com";
    expect(() => lookupApiBaseUrl()).toThrow(/https/);
  });
});

describe("postCheck", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the graded payload on 200", async () => {
    const payload = {
      status: "graded" as const,
      polygraph: "A" as const,
      notify_url: "https://polygraph.so/notify?for=npm/lodash",
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response);

    const result = await postCheck("npm/lodash");
    expect(result).toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://polygraph.so/api/cli/check");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      server_ref: "npm/lodash",
    });
  });

  it("returns the not_available payload with its next-step fields", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "not_available" as const,
        notify_url: "https://polygraph.so/notify?for=npm/obscure",
        message: "No published polygraph yet.",
        self_grade: "npx -y -p @polygraphso/litmus polygraphso-litmus litmus npm/obscure",
      }),
    } as Response);

    const result = await postCheck("npm/obscure");
    expect(result.status).toBe("not_available");
    if (result.status === "not_available") {
      expect(result.self_grade).toContain("polygraphso-litmus");
    }
  });

  it("throws PolygraphApiError on 400 with the server message", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Invalid server ref "garbage"' }),
    } as Response);

    await expect(postCheck("garbage")).rejects.toMatchObject({
      name: "PolygraphApiError",
      kind: "http",
      status: 400,
      message: 'Invalid server ref "garbage"',
    });
  });

  it("throws PolygraphApiError(network) when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(postCheck("npm/lodash")).rejects.toMatchObject({ kind: "network" });
  });

  it("throws PolygraphApiError(http) on 500", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    await expect(postCheck("npm/lodash")).rejects.toMatchObject({
      kind: "http",
      status: 500,
    });
  });
});

describe("postGradeRequest", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts server_ref, source, and agent_id, returning the queued payload", async () => {
    const payload = { status: "queued" as const, created: true, demand: 1 };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response);

    const result = await postGradeRequest("npm/foo-mcp", "claude-ai/1.2.0");

    expect(result).toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://polygraph.so/api/cli/grade-request");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      server_ref: "npm/foo-mcp",
      source: "mcp",
      agent_id: "claude-ai/1.2.0",
    });
  });

  it("omits agent_id from the body when the client is unknown", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "queued", created: false, demand: 3 }),
    } as Response);

    await postGradeRequest("npm/foo-mcp");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      server_ref: "npm/foo-mcp",
      source: "mcp",
    });
  });

  it("throws PolygraphApiError(network) when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(postGradeRequest("npm/foo-mcp")).rejects.toMatchObject({
      kind: "network",
    });
  });
});

describe("getList", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the response body on 200", async () => {
    const payload = {
      servers: [
        {
          server_ref: "npm/@modelcontextprotocol/server-filesystem",
          polygraph: "A" as const,
        },
      ],
      total: 1,
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response);

    const result = await getList();
    expect(result).toEqual(payload);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://polygraph.so/api/cli/list");
  });

  it("throws PolygraphApiError(network) when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(getList()).rejects.toMatchObject({ kind: "network" });
  });
});
