import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { runLitmus } from "../harness.js";

/**
 * Live, Docker-gated proof that a real pypi/uvx MCP server is graded under the
 * Docker sandbox: staged wheels-only into a venv, launched with the
 * venv python, and exercised — something the unit tests can't do. Opt-in (slow:
 * builds the image + stages from PyPI):
 *
 *   LITMUS_DOCKER_TESTS=1 pnpm --filter @polygraph/probes exec vitest run src/docker/pypi-live.test.ts
 *
 * `mcp-server-time` is a small, wheel-distributed, network-free official server, so
 * it should grade A (all four categories pass under the sandbox). The point is that
 * pypi now GRADES instead of erroring "unsupported for pypi".
 */

const docker = promisify(execFile);
const DOCKER_DIR = fileURLToPath(new URL("../../docker", import.meta.url));
const IMAGE_TAG = "polygraph-egress-sniff:latest";

async function hasDocker(): Promise<boolean> {
  try {
    await docker("docker", ["info"], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.env.LITMUS_DOCKER_TESTS !== "1")("pypi sandbox — live grade (Docker-gated)", () => {
  it("grades a real pypi server under isolation (no longer rejects pypi)", async () => {
    if (!(await hasDocker())) {
      console.log("docker unavailable — skipping live pypi grade test");
      return;
    }
    // Build the image up front (it now carries uv + python3) so the run doesn't race.
    await docker("docker", ["build", "-t", IMAGE_TAG, "-f", path.join(DOCKER_DIR, "egress-sniff.Dockerfile"), DOCKER_DIR], {
      timeout: 300_000,
    });

    const bundle = await runLitmus("pypi/mcp-server-time", { isolation: "docker", timeoutMs: 180_000 });

    // It produced a real grade — the whole point: pypi is gradeable, not an error.
    expect(["A", "B", "D", "F"]).toContain(bundle.grade);
    // C-02 actually ran under the sandbox (not skipped → not a B-cap from "no sandbox").
    expect(bundle.categories.find((c) => c.code === "C-02")?.status).not.toBe("skipped");
    // A network-free official server with no overreach should land at A.
    expect(bundle.grade).toBe("A");
    expect(bundle.toolDefsFingerprint).toMatch(/^0x[0-9a-f]{64}$/);
  }, 360_000);
});
