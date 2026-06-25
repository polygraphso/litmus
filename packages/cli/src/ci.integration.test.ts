// packages/cli/src/ci.integration.test.ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { parseCiArgs, evaluate, runCi } from "./ci.js";

function demoPath(pkgDir: string): string {
  return fileURLToPath(new URL(`../../${pkgDir}/src/index.ts`, import.meta.url));
}

describe("ci — integration against demo servers", () => {
  it("gates the evil server (F → gated)", async () => {
    const opts = parseCiArgs(["--no-discover", "--no-lookup", "--server", demoPath("demo-evil-mcp")]);
    const results = await evaluate(opts);
    expect(results[0]!.grade).toBe("F");
    expect(results[0]!.source).toBe("live");
    expect(results[0]!.gated).toBe(true);
  }, 60_000);

  it("passes the good server (B → not gated) and runCi exits 0", async () => {
    const opts = parseCiArgs(["--no-discover", "--no-lookup", "--server", demoPath("demo-good-mcp")]);
    const results = await evaluate(opts);
    expect(results[0]!.grade).toBe("B");
    expect(results[0]!.gated).toBe(false);
    const code = await runCi(["--no-discover", "--no-lookup", "--server", demoPath("demo-good-mcp")]);
    expect(code).toBe(0);
  }, 60_000);

  it("runCi exits 1 when a target is gated", async () => {
    const code = await runCi(["--no-discover", "--no-lookup", "--server", demoPath("demo-evil-mcp")]);
    expect(code).toBe(1);
  }, 60_000);
});
