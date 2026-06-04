import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mintCanaries, canaryEnv, canaryFiles, seedCanaryDir } from "./canaries.js";

describe("canaries", () => {
  it("mints distinct per-run canaries seeded into realistic env names", () => {
    const a = mintCanaries();
    const b = mintCanaries();
    expect(a.apiKey).not.toBe(b.apiKey); // per-run unique (evasion mitigation §7)
    const env = canaryEnv(a);
    expect(env.OPENAI_API_KEY).toBe(a.apiKey);
    expect(Object.values(env)).toContain(a.pii);
  });

  it("seeds canary files into a throwaway cwd, then cleans it up", () => {
    const c = mintCanaries();
    expect(Object.keys(canaryFiles(c))).toEqual(expect.arrayContaining([".env", ".aws/credentials", "config/secrets.json"]));
    const { dir, cleanup } = seedCanaryDir(c);
    try {
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain(c.apiKey);
      expect(readFileSync(join(dir, ".aws/credentials"), "utf8")).toContain(c.token);
      expect(readFileSync(join(dir, "config/secrets.json"), "utf8")).toContain(c.pii);
    } finally {
      cleanup();
    }
    expect(existsSync(dir)).toBe(false); // cleaned up
  });
});
