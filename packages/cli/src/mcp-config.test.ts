import { describe, it, expect } from "vitest";
import { normalizeUrl, resolveEnvPlaceholders, extractMatchingHeaders, resolveHeadersFromClientConfig, candidateConfigPaths, isAuthError } from "./mcp-config.js";

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

describe("resolveHeadersFromClientConfig — file walk", () => {
  const cwd = "/proj";
  const home = "/home/u";
  const env = { TOK: "live" } as NodeJS.ProcessEnv;

  it("prefers a project-local config over a user-global one", () => {
    const projectFile = candidateConfigPaths(cwd, home)[0]!; // /proj/.mcp.json
    const userFile = candidateConfigPaths(cwd, home).find((p) => p.endsWith(".claude.json"))!;
    const files: Record<string, string> = {
      [projectFile]: JSON.stringify({ mcpServers: { n: { url: "https://x/mcp", headers: { Authorization: "Bearer ${TOK}" } } } }),
      [userFile]: JSON.stringify({ mcpServers: { n: { url: "https://x/mcp", headers: { Authorization: "Bearer user" } } } }),
    };
    const got = resolveHeadersFromClientConfig("https://x/mcp", {
      cwd, home, env, readFile: (p) => files[p] ?? null,
    });
    expect(got).toEqual({ headers: { Authorization: "Bearer live" }, source: projectFile });
  });

  it("returns null when no config matches", () => {
    expect(
      resolveHeadersFromClientConfig("https://x/mcp", { cwd, home, env, readFile: () => null }),
    ).toBeNull();
  });

  it("skips a malformed config file rather than throwing", () => {
    const projectFile = candidateConfigPaths(cwd, home)[0];
    const got = resolveHeadersFromClientConfig("https://x/mcp", {
      cwd, home, env, readFile: (p) => (p === projectFile ? "{ not json" : null),
    });
    expect(got).toBeNull();
  });
});

describe("isAuthError", () => {
  it.each([
    "Error POSTing to endpoint (HTTP 401): invalid_token",
    "Request failed: 403 Forbidden",
    "Unauthorized",
    "No authorization provided",
  ])("treats %s as an auth error", (m) => {
    expect(isAuthError(new Error(m))).toBe(true);
  });

  it("does not treat an unrelated error as auth", () => {
    expect(isAuthError(new Error("ECONNREFUSED 500 internal"))).toBe(false);
  });
});
