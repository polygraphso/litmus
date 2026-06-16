import { describe, it, expect } from "vitest";
import { checkQuery } from "./check.js";

/**
 * A versioned ref looks up that exact version; a bare ref looks up the latest
 * graded version. The versionless serverKey is always what keys the lookup
 * (npm scopes must survive the @-version split), with the version sent separately.
 */
describe("checkQuery", () => {
  it("splits a version-pinned ref into the versionless key + version", () => {
    expect(checkQuery("npm/@scope/server@1.2.3")).toEqual({ ref: "npm/@scope/server", ver: "1.2.3" });
    expect(checkQuery("npm/lodash@4.17.21")).toEqual({ ref: "npm/lodash", ver: "4.17.21" });
  });

  it("returns a null version for a bare ref", () => {
    expect(checkQuery("npm/@scope/server")).toEqual({ ref: "npm/@scope/server", ver: null });
  });

  it("passes a non-registry target (URL / path) through unversioned", () => {
    expect(checkQuery("https://example.com/mcp")).toEqual({ ref: "https://example.com/mcp", ver: null });
  });
});
