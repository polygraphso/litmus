// packages/cli/src/ci.integration.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCiArgs, evaluate, runCi } from "./ci.js";

// These tests deliberately gate known-bad fixtures. Under GITHUB_ACTIONS, runCi would emit
// `::error::` annotations for them — fake "grade F" errors on an otherwise-green CI run.
// Suppress GitHub output here; the tests assert exit codes and grades, not annotations.
beforeAll(() => {
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_STEP_SUMMARY;
});

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

const CLEAN_SKILL = `---
name: format-markdown
description: Formats markdown files cleanly.
---
# Format markdown

When asked, tidy the markdown: normalize headings and wrap long lines.
Document the design system: spacing, type scale, and color tokens.
`;

describe("ci — integration against skills", () => {
  it("passes a clean skill (A → not gated) and runCi exits 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-skill-clean-"));
    try {
      mkdirSync(join(root, "skill"));
      writeFileSync(join(root, "skill/SKILL.md"), CLEAN_SKILL);
      const results = await evaluate(parseCiArgs(["--no-discover", "--no-lookup", "--skill", join(root, "skill")]));
      expect(results[0]!.kind).toBe("skill");
      expect(results[0]!.grade).toBe("A");
      expect(results[0]!.gated).toBe(false);
      expect(await runCi(["--no-discover", "--no-lookup", "--skill", join(root, "skill")])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("gates the evil skill fixture (D/F → exit 1)", async () => {
    const evil = fileURLToPath(new URL("../../probes/test-fixtures/demo-evil-skill", import.meta.url));
    const results = await evaluate(parseCiArgs(["--no-discover", "--no-lookup", "--skill", evil]));
    expect(results[0]!.kind).toBe("skill");
    expect(["D", "F"]).toContain(results[0]!.grade);
    expect(results[0]!.gated).toBe(true);
    expect(await runCi(["--no-discover", "--no-lookup", "--skill", evil])).toBe(1);
  }, 30_000);
});
