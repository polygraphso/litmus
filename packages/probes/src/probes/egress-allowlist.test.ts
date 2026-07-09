import { describe, it, expect } from "vitest";
import { parseAllowlistEnv, effectiveAllowlist, DEFAULT_EGRESS_BASELINE, PACKAGE_REGISTRY_BASELINE } from "./egress-allowlist.js";
import { hostAllowed } from "./host-match.js";

describe("DEFAULT_EGRESS_BASELINE", () => {
  it("seeds package-registry infrastructure (litmus-v15) so framework update-checks aren't overreach", () => {
    expect(DEFAULT_EGRESS_BASELINE).toEqual([...PACKAGE_REGISTRY_BASELINE]);
    // The FastMCP default startup ping (and pip/npm metadata checks) land here.
    expect(hostAllowed("pypi.org", DEFAULT_EGRESS_BASELINE)).toBe(true);
    expect(hostAllowed("files.pythonhosted.org", DEFAULT_EGRESS_BASELINE)).toBe(true);
    expect(hostAllowed("registry.npmjs.org", DEFAULT_EGRESS_BASELINE)).toBe(true);
  });

  it("does NOT allowlist the cloud instance-metadata endpoint (stays flagged)", () => {
    expect(hostAllowed("169.254.169.254", DEFAULT_EGRESS_BASELINE)).toBe(false);
    expect(hostAllowed("metadata.google.internal", DEFAULT_EGRESS_BASELINE)).toBe(false);
  });

  it("does NOT allowlist registry subdomains it did not name (exact hosts only)", () => {
    expect(hostAllowed("evil.pypi.org", DEFAULT_EGRESS_BASELINE)).toBe(false);
    expect(hostAllowed("test.pypi.org", DEFAULT_EGRESS_BASELINE)).toBe(false);
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
