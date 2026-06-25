import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { refFromCommand, stripNpmVersion, discoverTargets } from "./ci-discover.js";

describe("stripNpmVersion", () => {
  it("strips a trailing version from scoped and unscoped names", () => {
    expect(stripNpmVersion("@scope/pkg@1.2.3")).toBe("@scope/pkg");
    expect(stripNpmVersion("pkg@2.0.0")).toBe("pkg");
    expect(stripNpmVersion("@scope/pkg")).toBe("@scope/pkg");
    expect(stripNpmVersion("pkg")).toBe("pkg");
  });
});

describe("refFromCommand", () => {
  it("maps npx/npm to an npm ref", () => {
    expect(refFromCommand("npx", ["-y", "@scope/srv@1.0.0"])).toBe("npm/@scope/srv");
    expect(refFromCommand("npm", ["exec", "some-srv"])).toBe("npm/some-srv");
  });
  it("maps uvx/pipx to a pypi ref", () => {
    expect(refFromCommand("uvx", ["my-mcp"])).toBe("pypi/my-mcp");
    expect(refFromCommand("pipx", ["run", "my-mcp"])).toBe("pypi/my-mcp");
  });
  it("returns null for an unmappable command", () => {
    expect(refFromCommand("node", ["./local-server.js"])).toBeNull();
    expect(refFromCommand("/usr/bin/my-bin", [])).toBeNull();
  });
});

describe("discoverTargets", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ci-discover-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads mcpServers and servers, deriving refs and URLs", () => {
    writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          alpha: { command: "npx", args: ["-y", "@scope/alpha"] },
          beta: { url: "https://beta.example.com/mcp" },
          gamma: { command: "node", args: ["./gamma.js"] },
        },
      }),
    );
    mkdirSync(path.join(dir, ".vscode"));
    writeFileSync(
      path.join(dir, ".vscode/mcp.json"),
      JSON.stringify({ servers: { delta: { command: "uvx", args: ["delta-mcp"] } } }),
    );

    const found = discoverTargets(dir);
    const byName = Object.fromEntries(found.map((t) => [t.name, t]));
    expect(byName.alpha.ref).toBe("npm/@scope/alpha");
    expect(byName.beta.ref).toBe("https://beta.example.com/mcp");
    expect(byName.gamma.ref).toBeNull(); // unmappable command
    expect(byName.delta.ref).toBe("pypi/delta-mcp");
    expect(byName.alpha.source).toContain(".mcp.json");
  });

  it("ignores missing and malformed config files without throwing", () => {
    writeFileSync(path.join(dir, ".mcp.json"), "{ not valid json");
    expect(discoverTargets(dir)).toEqual([]);
  });

  it("treats a non-http url as unmappable (ref: null)", () => {
    writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { epsilon: { url: "file:///etc/passwd" } } }),
    );
    expect(discoverTargets(dir).find((t) => t.name === "epsilon")?.ref).toBeNull();
  });
});
