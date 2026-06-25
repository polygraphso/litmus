import { describe, it, expect, vi, afterEach } from "vitest";
import { checkQuery, lookupPublishedGrade } from "./check.js";

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

afterEach(() => vi.unstubAllGlobals());

describe("lookupPublishedGrade", () => {
  it("returns a structured grade when the API has one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({ attestation_uid: "0xabc", grade: "A", resolved_version: "1.2.3", network: "base" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )),
    );
    const g = await lookupPublishedGrade("npm/@scope/srv");
    expect(g).toEqual({ grade: "A", resolvedVersion: "1.2.3", attestationUid: "0xabc", network: "base" });
  });

  it("returns null when not available", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("null", { status: 200 })));
    expect(await lookupPublishedGrade("npm/@scope/srv")).toBeNull();
  });

  it("returns null on a non-A–F grade or a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await lookupPublishedGrade("npm/@scope/srv")).toBeNull();
  });
});
