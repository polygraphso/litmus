/**
 * github server grading — unit (always) + live (Docker-gated).
 *
 * The live tests clone, build, and run a real github-only MCP server in the
 * hardened sandbox and grade it end-to-end. They execute untrusted code, so they
 * are gated behind LITMUS_DOCKER_TESTS=1 (like the other *-live tests):
 *
 *   LITMUS_DOCKER_TESTS=1 pnpm --filter @polygraph/probes exec vitest run src/docker/github-live.test.ts
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runLitmus } from "../harness.js";
import { githubInstallArgs, githubResolverArgs } from "./staging.js";

const exec = promisify(execFile);

async function hasDocker(): Promise<boolean> {
  try {
    await exec("docker", ["info"], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

describe("github staging — argument builders (pure)", () => {
  it("install container BUILDS (no --ignore-scripts) and is hardened", () => {
    const args = githubInstallArgs("vol", "img", "cd /stage/src", "run-1", "runsc");
    const joined = args.join(" ");
    // The github path runs the target's build — the npm path's --ignore-scripts must NOT appear.
    expect(joined).not.toContain("--ignore-scripts");
    expect(args).toContain("--cap-drop=ALL");
    // DAC_OVERRIDE (only) is added back so the build can write the docker-cp'd tree.
    expect(joined).toContain("--cap-add DAC_OVERRIDE");
    expect(args).toContain("no-new-privileges");
    expect(joined).toContain("--memory 2g");
    expect(args).toContain("--runtime");
    expect(args).toContain("runsc");
    // The script rides after `sh -c`.
    expect(args[args.indexOf("-c") + 1]).toBe("cd /stage/src");
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
  });

  it("node resolver runs offline (network none) via node -e", () => {
    const args = githubResolverArgs("vol", "img", "node", undefined, undefined);
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("--user");
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("node");
    expect(args).toContain("-e");
  });

  it("python resolver runs offline via the venv python -c", () => {
    const args = githubResolverArgs("vol", "img", "python", undefined, undefined);
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("/stage/venv/bin/python");
    expect(args).toContain("-c");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });
});

const SHA40 = /^[0-9a-f]{40}$/;
const GRADES = ["A", "B", "C", "D", "F"];

describe.skipIf(process.env.LITMUS_DOCKER_TESTS !== "1")("github server grading — live (Docker-gated)", () => {
  it("clones, builds, and grades a Node github server (pins the commit SHA)", async () => {
    if (!(await hasDocker())) {
      console.log("docker unavailable — skipping github Node live");
      return;
    }
    // cow-mcp: a single-package TS server (tsc build, bin dist/index.js) that needs
    // no API key — exercises clone → npm install → build → launch → grade.
    const bundle = await runLitmus("github/krzysu/cow-mcp", {
      isolation: "docker",
      runLabel: `gh-live-${Math.random().toString(36).slice(2, 10)}`,
    });
    expect(GRADES).toContain(bundle.grade);
    expect(bundle.harness.stdioIsolation).toBe("docker");
    // The reproducibility anchor is the resolved commit SHA, not a semver.
    expect(bundle.resolvedVersion ?? "").toMatch(SHA40);
    expect(bundle.toolDefsFingerprint).toMatch(/^0x[0-9a-f]{64}$/);
  }, 600_000);

  it("clones, installs, and grades a Python github server", async () => {
    if (!(await hasDocker())) {
      console.log("docker unavailable — skipping github Python live");
      return;
    }
    // whattimeisit-mcp: a no-auth Python server (pyproject, requires-python >=3.13) —
    // exercises the uv-managed-python + build + venv-console-script path.
    const bundle = await runLitmus("github/kukapay/whattimeisit-mcp", {
      isolation: "docker",
      runLabel: `gh-live-${Math.random().toString(36).slice(2, 10)}`,
    });
    expect(GRADES).toContain(bundle.grade);
    expect(bundle.resolvedVersion ?? "").toMatch(SHA40);
  }, 600_000);
});
