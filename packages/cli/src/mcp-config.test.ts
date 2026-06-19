import { describe, it, expect } from "vitest";
import { normalizeUrl, resolveEnvPlaceholders, extractMatchingHeaders } from "./mcp-config.js";

describe("normalizeUrl", () => {
  it("lowercases host and drops a trailing slash", () => {
    expect(normalizeUrl("https://MCP.Noticed.so/api/mcp/")).toBe("https://mcp.noticed.so/api/mcp");
    expect(normalizeUrl("https://mcp.noticed.so/api/mcp")).toBe("https://mcp.noticed.so/api/mcp");
  });
});

describe("resolveEnvPlaceholders", () => {
  it("expands ${VAR} and ${env:VAR}; unknown collapses to empty", () => {
    const env = { TOK: "abc" } as NodeJS.ProcessEnv;
    expect(resolveEnvPlaceholders("Bearer ${TOK}", env)).toBe("Bearer abc");
    expect(resolveEnvPlaceholders("Bearer ${env:TOK}", env)).toBe("Bearer abc");
    expect(resolveEnvPlaceholders("Bearer ${MISSING}", env)).toBe("Bearer ");
  });
});

describe("extractMatchingHeaders", () => {
  const env = { TOK: "secret" } as NodeJS.ProcessEnv;

  it("finds headers for a matching url in an mcpServers map, resolving env", () => {
    const cfg = { mcpServers: { noticed: { url: "https://mcp.noticed.so/api/mcp", headers: { Authorization: "Bearer ${TOK}" } } } };
    expect(extractMatchingHeaders(cfg, "https://mcp.noticed.so/api/mcp/", env)).toEqual({ Authorization: "Bearer secret" });
  });

  it("supports the VS Code `servers` key", () => {
    const cfg = { servers: { n: { url: "https://x.example/mcp", headers: { "X-Api-Key": "k" } } } };
    expect(extractMatchingHeaders(cfg, "https://x.example/mcp", env)).toEqual({ "X-Api-Key": "k" });
  });

  it("looks inside projects.<path>.mcpServers (Claude Code ~/.claude.json)", () => {
    const cfg = { projects: { "/home/u/proj": { mcpServers: { n: { url: "https://y.example/mcp", headers: { Authorization: "t" } } } } } };
    expect(extractMatchingHeaders(cfg, "https://y.example/mcp", env)).toEqual({ Authorization: "t" });
  });

  it("returns null when the url does not match or there are no headers", () => {
    expect(extractMatchingHeaders({ mcpServers: { n: { url: "https://other/mcp", headers: { a: "b" } } } }, "https://x/mcp", env)).toBeNull();
    expect(extractMatchingHeaders({ mcpServers: { n: { url: "https://x/mcp" } } }, "https://x/mcp", env)).toBeNull();
  });
});
