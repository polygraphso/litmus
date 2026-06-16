import { describe, it, expect } from "vitest";
import { parseAllowlistEnv, effectiveAllowlist, DEFAULT_EGRESS_BASELINE } from "./egress-allowlist.js";

describe("DEFAULT_EGRESS_BASELINE", () => {
  it("is empty so non-declaring servers behave exactly as pre-v3", () => {
    expect(DEFAULT_EGRESS_BASELINE).toEqual([]);
  });
});

describe("parseAllowlistEnv", () => {
  it("splits, trims, lowercases, and drops blanks", () => {
    expect(parseAllowlistEnv("a.com, B.com ,, *.x.com ")).toEqual(["a.com", "b.com", "*.x.com"]);
  });
  it("returns [] for undefined/empty", () => {
    expect(parseAllowlistEnv(undefined)).toEqual([]);
    expect(parseAllowlistEnv("")).toEqual([]);
    expect(parseAllowlistEnv("  , ")).toEqual([]);
  });
});

describe("effectiveAllowlist", () => {
  it("unions baseline + declared, deduped case-insensitively, baseline first", () => {
    expect(effectiveAllowlist(["a.com"], ["b.com", "A.COM"])).toEqual(["a.com", "b.com"]);
    expect(effectiveAllowlist([], ["polygraph.so"])).toEqual(["polygraph.so"]);
    expect(effectiveAllowlist([], [])).toEqual([]);
  });
});
