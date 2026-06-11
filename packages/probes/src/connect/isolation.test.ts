import { describe, it, expect } from "vitest";
import { connectTarget, IsolationUnsupportedError } from "./index.js";

/**
 * isolation:"docker" is supported only for npm refs. Every other stdio kind
 * fails closed with IsolationUnsupportedError BEFORE any host execution (these
 * throws happen before Docker is touched, so they run without a daemon). http
 * targets are unaffected — isolation is stdio-only.
 */

describe("connectTarget — isolation:'docker' unsupported kinds (fail closed)", () => {
  it("throws IsolationUnsupportedError for an explicit stdio command", async () => {
    await expect(
      connectTarget({ command: "node", args: ["-e", "1"] }, { isolation: "docker" }),
    ).rejects.toBeInstanceOf(IsolationUnsupportedError);
  });

  it("throws IsolationUnsupportedError for a pypi ref, naming the kind", async () => {
    await expect(connectTarget("pypi/mcp-server-git", { isolation: "docker" })).rejects.toThrow(
      /pypi/,
    );
    await expect(connectTarget("pypi/mcp-server-git", { isolation: "docker" })).rejects.toBeInstanceOf(
      IsolationUnsupportedError,
    );
  });
});
