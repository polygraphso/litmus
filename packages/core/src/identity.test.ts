import { describe, it, expect } from "vitest";
import {
  parseServerRef,
  formatServerRef,
  serverKey,
  ServerRefParseError,
} from "./identity.js";

describe("parseServerRef", () => {
  it("parses a scoped npm ref with version", () => {
    expect(parseServerRef("npm/@modelcontextprotocol/server-filesystem@0.4.2")).toEqual({
      registry: "npm",
      owner: "@modelcontextprotocol",
      name: "server-filesystem",
      version: "0.4.2",
    });
  });

  it("parses an unscoped npm ref without version", () => {
    expect(parseServerRef("npm/lodash")).toEqual({
      registry: "npm",
      owner: null,
      name: "lodash",
      version: null,
    });
  });

  it("parses a pypi ref (no owner)", () => {
    expect(parseServerRef("pypi/mcp-server-git@1.0.0")).toEqual({
      registry: "pypi",
      owner: null,
      name: "mcp-server-git",
      version: "1.0.0",
    });
  });

  it("requires owner for github", () => {
    expect(() => parseServerRef("github/just-a-name")).toThrow(ServerRefParseError);
    expect(parseServerRef("github/anthropic/mcp-server-foo@v0.1.3")).toEqual({
      registry: "github",
      owner: "anthropic",
      name: "mcp-server-foo",
      version: "v0.1.3",
    });
  });

  it("rejects unknown registries and empty versions", () => {
    expect(() => parseServerRef("cargo/foo")).toThrow(ServerRefParseError);
    expect(() => parseServerRef("npm/lodash@")).toThrow(ServerRefParseError);
    expect(() => parseServerRef("nostslash")).toThrow(ServerRefParseError);
  });
});

describe("formatServerRef / serverKey", () => {
  it("round-trips a parsed ref", () => {
    const ref = "npm/@modelcontextprotocol/server-filesystem@0.4.2";
    expect(formatServerRef(parseServerRef(ref))).toBe(ref);
  });

  it("serverKey drops the version", () => {
    expect(serverKey(parseServerRef("npm/@scope/name@1.2.3"))).toBe("npm/@scope/name");
    expect(serverKey(parseServerRef("pypi/thing@9"))).toBe("pypi/thing");
  });
});
