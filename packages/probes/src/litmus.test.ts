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
    expect(bundle.methodologyVersion).toBe("litmus-v12");
    expect(bundle.schemaVersion).toBe("1.7.0");
  }, 60_000);

  it("grades the good server B (C-01 + C-03 pass; C-02 skipped without Docker)", async () => {
    const bundle = await runLitmus(demoCommand("demo-good-mcp"));
    expect(bundle.categories.find((c) => c.code === "C-01")?.status).toBe("pass");
    expect(bundle.categories.find((c) => c.code === "C-03")?.status).toBe("pass");
    expect(bundle.categories.find((c) => c.code === "C-02")?.status).toBe("skipped");
    expect(bundle.grade).toBe("B");
  }, 60_000);

  it("grades the mislabel server D (C-02 fails via probe 2.1; C-01/C-03 stay clean)", async () => {
    const bundle = await runLitmus(demoCommand("demo-mislabel-mcp"));
    expect(bundle.categories.find((c) => c.code === "C-01")?.status).toBe("pass");
    expect(bundle.categories.find((c) => c.code === "C-03")?.status).toBe("pass");
    const c02 = bundle.categories.find((c) => c.code === "C-02");
    expect(c02?.status).toBe("fail");
    const probe21 = c02?.probes.find((p) => p.id === "2.1");
    expect(probe21?.status).toBe("fail");
    const flagged = probe21?.findings.map((f) => f.tool) ?? [];
    expect(flagged).toContain("delete_records"); // destructive NAME (v4)
    expect(flagged).toContain("process_request"); // mutation-evidencing PARAMETER (v5)
    expect(flagged).toContain("apply_changes"); // mutation-evidencing DESCRIPTION (v5)
    expect(flagged).not.toContain("lookup_account"); // polysemous negative control — not a lie
    expect(probe21?.findings[0]?.tool).toBe("delete_records");
    expect(bundle.grade).toBe("D"); // declared-permission lie caps at D, like unexpected egress

    // The lying tools must no longer be actively bait-called (C-01 1.2): they
    // claim read-only but evidence mutation, so the union skip-set excludes them.
    const c01 = bundle.categories.find((c) => c.code === "C-01");
    const p12reason = c01?.probes.find((p) => p.id === "1.2")?.reason ?? "";
    expect(p12reason).toContain("delete_records");
    expect(p12reason).toContain("process_request");
    expect(p12reason).toContain("apply_changes");
  }, 60_000);

  it("grades the malformed server D (C-04 fails on adversarial input; C-01/C-03 stay clean, capped at D not F)", async () => {
    const bundle = await runLitmus(demoCommand("demo-malformed-mcp"));
    expect(bundle.categories.find((c) => c.code === "C-01")?.status).toBe("pass");
    expect(bundle.categories.find((c) => c.code === "C-03")?.status).toBe("pass");
    const c04 = bundle.categories.find((c) => c.code === "C-04");
    expect(c04?.status).toBe("fail");
    const probe31 = c04?.probes.find((p) => p.id === "3.1");
    expect(probe31?.findings.some((f) => f.kind === "internals-leak")).toBe(true); // leaked a stack trace
    expect(bundle.grade).toBe("D"); // robustness failure caps at D, not the C-01/C-03 F
  }, 60_000);

  it("grades the leaky server F (C-03 data leak — canary surfaced in output)", async () => {
    const bundle = await runLitmus(demoCommand("demo-leaky-mcp"));
    expect(bundle.categories.find((c) => c.code === "C-01")?.status).toBe("pass");
    expect(bundle.categories.find((c) => c.code === "C-03")?.status).toBe("fail");
    expect(bundle.grade).toBe("F");
  }, 60_000);

  it("grades the injecting server F via probe 1.2 (output injection; descriptions stay clean)", async () => {
    const bundle = await runLitmus(demoCommand("demo-injecting-mcp"));
    const c01 = bundle.categories.find((c) => c.code === "C-01");
    expect(c01?.status).toBe("fail");
    expect(c01?.probes.find((p) => p.id === "1.1")?.status).toBe("pass"); // clean descriptions
    expect(c01?.probes.find((p) => p.id === "1.2")?.status).toBe("fail"); // injection in the outputs
    expect(bundle.grade).toBe("F");
  }, 60_000);

  it("grades the second-order server F via probe 1.3 (output→downstream input; 1.1/1.2 clean)", async () => {
    const bundle = await runLitmus(demoCommand("demo-secondorder-mcp"));
    const c01 = bundle.categories.find((c) => c.code === "C-01");
    expect(c01?.probes.find((p) => p.id === "1.1")?.status).toBe("pass"); // clean descriptions
    expect(c01?.probes.find((p) => p.id === "1.2")?.status).toBe("pass"); // clean on bait
    expect(c01?.probes.find((p) => p.id === "1.3")?.status).toBe("fail"); // weaponizes a chained output
    expect(c01?.status).toBe("fail");
    expect(bundle.grade).toBe("F");
  }, 60_000);

  it("second-order grade + fingerprint are stable across runs (determinism §6)", async () => {
    const a = await runLitmus(demoCommand("demo-secondorder-mcp"));
    const b = await runLitmus(demoCommand("demo-secondorder-mcp"));
    expect(a.grade).toBe(b.grade);
    expect(a.toolDefsFingerprint).toBe(b.toolDefsFingerprint);
  }, 60_000);

  it("produces a stable fingerprint AND grade across runs (rug-pull + bait-pool determinism guard)", async () => {
    const a = await runLitmus(demoCommand("demo-good-mcp"));
    const b = await runLitmus(demoCommand("demo-good-mcp"));
    expect(a.toolDefsFingerprint).toBe(b.toolDefsFingerprint);
    expect(a.grade).toBe(b.grade); // varied bait pool must not make the verdict non-deterministic (§6)
  }, 60_000);

  it("captures the server's self-reported serverInfo.version as descriptive metadata", async () => {
    // demo-good-mcp declares version "1.4.2" in its serverInfo. The harness reads
    // it from the MCP initialize handshake and records it as self-asserted
    // metadata — distinct from resolvedVersion (a re-fetchable package pin),
    // which is null here because the target is an explicit stdio command.
    const bundle = await runLitmus(demoCommand("demo-good-mcp"));
    expect(bundle.selfReportedVersion).toBe("1.4.2");
    expect(bundle.resolvedVersion).toBeNull();
  }, 60_000);

  it("enforces an overall timeoutMs: the aggregate probe sequence is bounded", async () => {
    // The good server's listTools + bait calls take >1ms, so a 1ms ceiling trips.
    // This guards the in-process (https) path: without a top-level bound, a hostile
    // server could pin the single-flight queue for hours (MAX_TOOLS × per-call).
    // The connection still tears down in the finally on a timeout rejection.
    await expect(
      runLitmus(demoCommand("demo-good-mcp"), { timeoutMs: 1 }),
    ).rejects.toThrow(/litmus run exceeded/);
  }, 60_000);
});
