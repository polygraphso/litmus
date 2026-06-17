import { describe, it, expect } from "vitest";
import { normalizeHost, hostMatchesPattern, hostAllowed, parseHostPortPattern, hostPortMatches } from "./host-match.js";

describe("normalizeHost", () => {
  it("lowercases, trims, and strips a trailing dot and :port", () => {
    expect(normalizeHost("  Example.COM. ")).toBe("example.com");
    expect(normalizeHost("polygraph.so:8443")).toBe("polygraph.so");
    expect(normalizeHost("API.OpenAI.com:443")).toBe("api.openai.com");
  });
});

describe("hostMatchesPattern", () => {
  it("matches exact hosts case-insensitively", () => {
    expect(hostMatchesPattern("polygraph.so", "polygraph.so")).toBe(true);
    expect(hostMatchesPattern("Polygraph.SO", "polygraph.so")).toBe(true);
    expect(hostMatchesPattern("a.polygraph.so", "polygraph.so")).toBe(false);
  });

  it("supports *.domain wildcards on label boundaries (sub, not apex)", () => {
    expect(hostMatchesPattern("a.example.com", "*.example.com")).toBe(true);
    expect(hostMatchesPattern("a.b.example.com", "*.example.com")).toBe(true);
    expect(hostMatchesPattern("example.com", "*.example.com")).toBe(false); // apex must be listed explicitly
    expect(hostMatchesPattern("evilexample.com", "*.example.com")).toBe(false); // not a label boundary
  });

  it("does not treat the pattern's dots as regex", () => {
    expect(hostMatchesPattern("aXexample.com", "a.example.com")).toBe(false);
  });
});

describe("hostAllowed", () => {
  it("is true when any pattern matches, false otherwise", () => {
    expect(hostAllowed("polygraph.so", ["api.openai.com", "polygraph.so"])).toBe(true);
    expect(hostAllowed("a.githubusercontent.com", ["*.githubusercontent.com"])).toBe(true);
    expect(hostAllowed("evil.com", ["polygraph.so", "*.openai.com"])).toBe(false);
    expect(hostAllowed("anything.com", [])).toBe(false);
  });
});

describe("parseHostPortPattern (litmus-v5)", () => {
  it("treats a trailing numeric :port as a port constraint", () => {
    expect(parseHostPortPattern("api.example.com:443")).toEqual({ host: "api.example.com", port: 443 });
    expect(parseHostPortPattern("*.example.com:8443")).toEqual({ host: "*.example.com", port: 8443 });
  });
  it("treats no-colon / non-numeric / out-of-range tails as host-only (any port)", () => {
    expect(parseHostPortPattern("api.example.com")).toEqual({ host: "api.example.com", port: null });
    expect(parseHostPortPattern("api.example.com:notaport")).toEqual({ host: "api.example.com:notaport", port: null });
    expect(parseHostPortPattern("api.example.com:0")).toEqual({ host: "api.example.com:0", port: null });
    expect(parseHostPortPattern("api.example.com:99999")).toEqual({ host: "api.example.com:99999", port: null });
  });
});

describe("hostPortMatches (litmus-v5)", () => {
  it("a host-only pattern allows any port (backward-compatible)", () => {
    expect(hostPortMatches("api.example.com", 4444, "api.example.com")).toBe(true);
    expect(hostPortMatches("api.example.com", undefined, "api.example.com")).toBe(true);
  });
  it("a port-pinned pattern allows only that port", () => {
    expect(hostPortMatches("api.example.com", 443, "api.example.com:443")).toBe(true);
    expect(hostPortMatches("api.example.com", 4444, "api.example.com:443")).toBe(false);
  });
  it("a port-pinned pattern never matches an unknown observed port (safe-by-construction)", () => {
    expect(hostPortMatches("api.example.com", undefined, "api.example.com:443")).toBe(false);
  });
  it("still requires the host to match", () => {
    expect(hostPortMatches("evil.com", 443, "api.example.com:443")).toBe(false);
    expect(hostPortMatches("a.example.com", 443, "*.example.com:443")).toBe(true);
  });
});
