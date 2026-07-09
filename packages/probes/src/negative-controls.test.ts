import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { runLitmus } from "./harness.js";
import type { LitmusGrade } from "@polygraph/core";
import type { StdioCommand } from "./connect/index.js";

/**
 * Negative-control ratchet guard (litmus-v16, P7). The methodology has only ever
 * been recalibrated to CUT false positives (v7/v8/v13/v14 all move verdicts D→higher).
 * That one-directional ratchet risks silently lowering SENSITIVITY over time. This
 * suite pins the intended verdict of every purpose-built demo server, so a future
 * FP fix that also stops catching a real failure fails loudly here.
 *
 * Run WITHOUT Docker (the default CI shape): C-02's egress sandbox is skipped, so
 * egress-only failers (demo-phonehome) grade B here — their wire-exfil failure is
 * covered by the Docker-gated live tests. Everything else is deterministic.
 */

const require = createRequire(import.meta.url);

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

/** Expected verdict per demo (no-Docker shape), and the category that carries it. */
const MATRIX: Array<{ pkg: string; grade: LitmusGrade; failing?: "C-01" | "C-02" | "C-03" | "C-04" }> = [
  { pkg: "demo-good-mcp", grade: "B" }, // clean; C-02 skipped without Docker
  { pkg: "demo-passthrough-mcp", grade: "B" }, // relays external content verbatim → 1.4 discloses, not fails
  { pkg: "demo-evil-mcp", grade: "F", failing: "C-01" }, // injection in a tool description
  { pkg: "demo-toolpoison-mcp", grade: "F", failing: "C-01" }, // agent-directed poisoning in a description
  { pkg: "demo-injecting-mcp", grade: "F", failing: "C-01" }, // injection in tool OUTPUT (1.2)
  { pkg: "demo-secondorder-mcp", grade: "F", failing: "C-01" }, // second-order injection (1.3)
  { pkg: "demo-leaky-mcp", grade: "F", failing: "C-03" }, // canary leaked in output (4.1)
  { pkg: "demo-mislabel-mcp", grade: "D", failing: "C-02" }, // readOnlyHint lie (2.1)
  { pkg: "demo-malformed-mcp", grade: "D", failing: "C-04" }, // stack trace on malformed input (3.1)
];

describe("negative controls — every demo grades at its intended verdict (ratchet guard)", () => {
  for (const { pkg, grade, failing } of MATRIX) {
    it(`${pkg} → ${grade}${failing ? ` (${failing} fail)` : ""}`, async () => {
      const bundle = await runLitmus(demoCommand(pkg));
      expect(bundle.grade, `${pkg} grade`).toBe(grade);
      if (failing) {
        expect(bundle.categories.find((c) => c.code === failing)?.status, `${pkg} ${failing}`).toBe("fail");
      }
    }, 60_000);
  }

  it("demo-passthrough-mcp: probe 1.4 discloses the conduit without failing C-01", async () => {
    const bundle = await runLitmus(demoCommand("demo-passthrough-mcp"));
    const c01 = bundle.categories.find((c) => c.code === "C-01");
    expect(c01?.status).toBe("pass");
    const p14 = c01?.probes.find((p) => p.id === "1.4");
    expect(p14?.findings.some((f) => f.kind === "indirect-injection")).toBe(true);
  }, 60_000);
});
