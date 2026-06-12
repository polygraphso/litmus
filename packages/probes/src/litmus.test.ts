import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { runLitmus } from "./harness.js";
import type { StdioCommand } from "./connect/index.js";

const require = createRequire(import.meta.url);

/** Resolve the tsx CLI so we can launch the TypeScript demo servers over stdio. */
function tsxCli(): string {
  const pkgJsonPath = require.resolve("tsx/package.json");
  const dir = path.dirname(pkgJsonPath);
  const bin = (require(pkgJsonPath) as { bin: string | Record<string, string> }).bin;
  const rel = typeof bin === "string" ? bin : (bin.tsx ?? "./dist/cli.mjs");
  return path.join(dir, rel);
}

function demoCommand(pkgDir: string): StdioCommand {
  const entry = fileURLToPath(new URL(`../../${pkgDir}/src/index.ts`, import.meta.url));
  return { command: process.execPath, args: [tsxCli(), entry] };
}

describe("runLitmus — integration against demo MCP servers", () => {
  it("grades the evil server F (C-01 injection in a tool description)", async () => {
    const bundle = await runLitmus(demoCommand("demo-evil-mcp"));
    expect(bundle.grade).toBe("F");
    const c01 = bundle.categories.find((c) => c.code === "C-01");
    expect(c01?.status).toBe("fail");
    expect(bundle.toolDefsFingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    expect(bundle.methodologyVersion).toBe("litmus-v1");
  }, 30_000);

  it("grades the good server B (C-01 + C-03 pass; C-02 skipped without Docker)", async () => {
    const bundle = await runLitmus(demoCommand("demo-good-mcp"));
    expect(bundle.categories.find((c) => c.code === "C-01")?.status).toBe("pass");
    expect(bundle.categories.find((c) => c.code === "C-03")?.status).toBe("pass");
    expect(bundle.categories.find((c) => c.code === "C-02")?.status).toBe("skipped");
    expect(bundle.grade).toBe("B");
  }, 30_000);

  it("grades the leaky server F (C-03 data leak — canary surfaced in output)", async () => {
    const bundle = await runLitmus(demoCommand("demo-leaky-mcp"));
    expect(bundle.categories.find((c) => c.code === "C-01")?.status).toBe("pass");
    expect(bundle.categories.find((c) => c.code === "C-03")?.status).toBe("fail");
    expect(bundle.grade).toBe("F");
  }, 30_000);

  it("grades the injecting server F via probe 1.2 (output injection; descriptions stay clean)", async () => {
    const bundle = await runLitmus(demoCommand("demo-injecting-mcp"));
    const c01 = bundle.categories.find((c) => c.code === "C-01");
    expect(c01?.status).toBe("fail");
    expect(c01?.probes.find((p) => p.id === "1.1")?.status).toBe("pass"); // clean descriptions
    expect(c01?.probes.find((p) => p.id === "1.2")?.status).toBe("fail"); // injection in the outputs
    expect(bundle.grade).toBe("F");
  }, 30_000);

  it("produces a stable fingerprint AND grade across runs (rug-pull + bait-pool determinism guard)", async () => {
    const a = await runLitmus(demoCommand("demo-good-mcp"));
    const b = await runLitmus(demoCommand("demo-good-mcp"));
    expect(a.toolDefsFingerprint).toBe(b.toolDefsFingerprint);
    expect(a.grade).toBe(b.grade); // varied bait pool must not make the verdict non-deterministic (§6)
  }, 30_000);

  it("enforces an overall timeoutMs: the aggregate probe sequence is bounded", async () => {
    // The good server's listTools + bait calls take >1ms, so a 1ms ceiling trips.
    // This guards the in-process (https) path: without a top-level bound, a hostile
    // server could pin the single-flight queue for hours (MAX_TOOLS × per-call).
    // The connection still tears down in the finally on a timeout rejection.
    await expect(
      runLitmus(demoCommand("demo-good-mcp"), { timeoutMs: 1 }),
    ).rejects.toThrow(/litmus run exceeded/);
  }, 30_000);
});
