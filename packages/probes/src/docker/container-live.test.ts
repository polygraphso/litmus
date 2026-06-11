import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { runLitmus } from "../harness.js";
import { connectTarget } from "../connect/index.js";
import { containerLaunch, prepareSeedVolume } from "../connect/container.js";
import { ensureImage, stageFromTarball } from "./staging.js";
import { mintCanaries, canaryEnv } from "../probes/canaries.js";
import { c01Injection } from "../probes/c01-injection.js";
import { c03Sensitive } from "../probes/c03-sensitive.js";
import { gradeFromCategories } from "../grade.js";
import type { ProbeContext } from "../probes/context.js";
import type { EgressResult } from "./egress-runner.js";
import type { ToolDef } from "@polygraph/core";

/**
 * Live, Docker-gated proof of the go/no-go: an npm target's code runs ONLY
 * inside the hardened container, reached over stdio through `docker run -i`.
 * Opt-in (slow: two npm installs + an image build):
 *
 *   LITMUS_DOCKER_TESTS=1 pnpm --filter @polygraph/probes exec vitest run src/docker/container-live.test.ts
 *
 * 1) Happy path: a real npm MCP graded end-to-end under isolation; the bundle
 *    records stdioIsolation:"docker", the overridden disclaimer, a genuinely-run
 *    C-02, and a resolved semver.
 * 2) F path: the leaky-bin-mcp fixture is npm-packed, staged from its tarball,
 *    and exercised with a canary seeded via `-e` into the container — proving the
 *    canary travels INTO the container and leaks back OUT through the tool output
 *    (C-03 4.1 ⇒ grade F).
 */

const docker = promisify(execFile);
const exec = promisify(execFile);

const HOSTED_DISCLAIMER =
  "Operator-run and operator-minted by polygraph under litmus-v1. Independent of the subject, but trust shifts to the operator; not hardware-attested. Re-run the open harness to verify.";

async function hasDocker(): Promise<boolean> {
  try {
    await docker("docker", ["info"], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.env.LITMUS_DOCKER_TESTS !== "1")("containerized stdio connect — live (Docker-gated)", () => {
  it("grades a real npm MCP end-to-end under isolation (happy path)", async () => {
    if (!(await hasDocker())) {
      console.log("docker unavailable — skipping container-live happy path");
      return;
    }
    const bundle = await runLitmus("npm/@modelcontextprotocol/server-everything", {
      isolation: "docker",
      runLabel: `live-test-${Math.random().toString(36).slice(2, 10)}`,
      disclaimer: HOSTED_DISCLAIMER,
    });

    expect(bundle.harness.stdioIsolation).toBe("docker");
    expect(bundle.disclaimer).toBe(HOSTED_DISCLAIMER);
    // C-02 genuinely ran under isolation (no B-cap / skip allowed).
    const c02 = bundle.categories.find((c) => c.code === "C-02");
    expect(c02?.status).not.toBe("skipped");
    // The offline resolver surfaced the exact version actually run.
    expect(bundle.resolvedVersion).toMatch(/^\d+\.\d+\.\d+/);
  }, 600_000);

  it("grades the leaky-bin fixture F via a canary that flows INTO the container (F path)", async () => {
    if (!(await hasDocker())) {
      console.log("docker unavailable — skipping container-live F path");
      return;
    }
    const runLabel = `live-test-${Math.random().toString(36).slice(2, 10)}`;
    const fixtureDir = fileURLToPath(new URL("../../test-fixtures/leaky-bin-mcp", import.meta.url));

    const workDir = mkdtempSync(path.join(tmpdir(), "pg-leaky-pack-"));
    const seedDir = mkdtempSync(path.join(tmpdir(), "pg-leaky-seed-"));
    let staged: Awaited<ReturnType<typeof stageFromTarball>> | null = null;
    let seedVol: Awaited<ReturnType<typeof prepareSeedVolume>> | null = null;
    let conn: Awaited<ReturnType<typeof connectTarget>> | null = null;
    try {
      await ensureImage();

      // npm pack the fixture into the tmpdir → a single .tgz tarball.
      const { stdout } = await exec("npm", ["pack", fixtureDir, "--pack-destination", workDir], {
        timeout: 120_000,
      });
      const tarName = stdout.trim().split("\n").pop()!.trim();
      const tarball = path.join(workDir, tarName);

      staged = await stageFromTarball(tarball, "leaky-bin-mcp", { runLabel });

      // A canary seed dir (read-only data) and matching canary env. The same
      // canaries are passed BOTH as files (irrelevant to this fixture) and via
      // `-e` env (which the fixture echoes back through `get_config`).
      const canaries = mintCanaries();
      writeFileSync(path.join(seedDir, ".env"), `OPENAI_API_KEY=${canaries.apiKey}\n`, "utf8");
      seedVol = await prepareSeedVolume(seedDir, { runLabel });

      const env = canaryEnv(canaries);
      const { command, args } = containerLaunch({
        entry: staged.entry,
        stageVolume: staged.volume,
        seedVolume: seedVol.volume,
        canaryEnv: env,
        runLabel,
      });

      conn = await connectTarget({ command, args, serverRef: "npm/leaky-bin-mcp" });

      const listed = await conn.client.listTools();
      const tools: ToolDef[] = (listed.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? null,
      }));
      const ctx: ProbeContext = { client: conn.client, tools, canaries: canaries.all, dockerAvailable: true };
      // Egress ran clean (the canary leaks through the OUTPUT, probe 4.1, not the wire).
      const egress: EgressResult = { ran: true, reason: null, attempts: [] };

      const categories = [await c01Injection(ctx), await c03Sensitive(ctx, egress)];
      const grade = gradeFromCategories(categories);

      expect(grade.grade).toBe("F");
      const c03 = categories.find((c) => c.code === "C-03");
      expect(c03?.status).toBe("fail");
      const p41 = c03?.probes.find((p) => p.id === "4.1");
      expect(p41?.status).toBe("fail");
      expect(p41?.findings.some((f) => f.kind === "canary")).toBe(true);
    } finally {
      if (conn) await conn.teardown();
      if (seedVol) await seedVol.cleanup();
      if (staged) await staged.cleanup();
      rmSync(workDir, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
  }, 600_000);
});
