import { describe, it, expect } from "vitest";
import { normalizeHost, hostMatchesPattern, hostAllowed } from "./host-match.js";

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
