import { describe, it, expect } from "vitest";
import { orderBinCandidates, parseNpmBins, probeForMcpBin, NoMcpBinError } from "./bin-candidates.js";

describe("orderBinCandidates", () => {
  it("puts an mcp-named bin first", () => {
    expect(orderBinCandidates(["foo-cli", "foo-mcp"], "foo")).toEqual(["foo-mcp", "foo-cli"]);
    expect(orderBinCandidates(["polygraphso-litmus", "polygraphso-litmus-mcp"], "litmus")).toEqual([
      "polygraphso-litmus-mcp",
      "polygraphso-litmus",
    ]);
  });

  it("falls back to the package-name bin, then the rest, preserving order", () => {
    expect(orderBinCandidates(["other", "mypkg", "x-mcp"], "mypkg")).toEqual(["x-mcp", "mypkg", "other"]);
  });

  it("preserves order when nothing matches mcp or the package name", () => {
    expect(orderBinCandidates(["a", "b"], "c")).toEqual(["a", "b"]);
  });

  it("dedups and handles a single bin", () => {
    expect(orderBinCandidates(["only"], "only")).toEqual(["only"]);
    expect(orderBinCandidates(["a", "a-mcp"], "a")).toEqual(["a-mcp", "a"]);
  });
});

describe("parseNpmBins", () => {
  it("returns the keys of an object bin map", () => {
    expect(parseNpmBins('{"polygraphso-litmus":"dist/cli.js","polygraphso-litmus-mcp":"dist/mcp.js"}', "litmus")).toEqual([
      "polygraphso-litmus",
      "polygraphso-litmus-mcp",
    ]);
  });

  it("treats a string bin as a single bin named after the package", () => {
    expect(parseNpmBins('"dist/cli.js"', "lodash")).toEqual(["lodash"]);
  });

  it("returns [] for empty/missing/invalid output", () => {
    expect(parseNpmBins("", "x")).toEqual([]);
    expect(parseNpmBins("{}", "x")).toEqual([]);
    expect(parseNpmBins("not json", "x")).toEqual([]);
    expect(parseNpmBins("[]", "x")).toEqual([]);
  });
});

describe("probeForMcpBin", () => {
  it("returns the first candidate that yields a non-null result, skipping earlier failures", async () => {
    const calls: string[] = [];
    const attempt = async (bin: string) => {
      calls.push(bin);
      return bin === "b" ? { conn: bin } : null;
    };
    const got = await probeForMcpBin("npm/x", ["a", "b", "c"], attempt);
    expect(got).toEqual({ bin: "b", result: { conn: "b" } });
    expect(calls).toEqual(["a", "b"]); // stopped at first success — never tried "c"
  });

  it("throws NoMcpBinError naming what was tried when none qualify", async () => {
    await expect(probeForMcpBin("npm/x", ["a", "b"], async () => null)).rejects.toBeInstanceOf(NoMcpBinError);
    await expect(probeForMcpBin("npm/x", ["a", "b"], async () => null)).rejects.toThrow(/a, b/);
  });
});
