import { describe, it, expect, vi } from "vitest";
import {
  RESOLVER_SCRIPT,
  labelFlags,
  volumeCreateArgs,
  stageInstallArgs,
  resolverRunArgs,
  tarballCopyContainerArgs,
  parseResolverOutput,
  ensureImage,
} from "./staging.js";

const IMAGE = "polygraph-egress-sniff:latest";

describe("labelFlags", () => {
  it("is empty when no runLabel is set", () => {
    expect(labelFlags(undefined)).toEqual([]);
  });
  it("emits a single polygraph-litmus-run label pair when set", () => {
    expect(labelFlags("run-123")).toEqual(["--label", "polygraph-litmus-run=run-123"]);
  });
});

describe("volumeCreateArgs", () => {
  it("creates a named volume with no label when unlabeled", () => {
    expect(volumeCreateArgs("pg-stage-abc", undefined)).toEqual(["volume", "create", "pg-stage-abc"]);
  });
  it("labels the volume when a runLabel is set", () => {
    expect(volumeCreateArgs("pg-stage-abc", "run-123")).toEqual([
      "volume",
      "create",
      "--label",
      "polygraph-litmus-run=run-123",
      "pg-stage-abc",
    ]);
  });
});

describe("stageInstallArgs", () => {
  it("runs the hardened, --ignore-scripts npm install with `--` before the pkgSpec", () => {
    const args = stageInstallArgs("pg-stage-abc", IMAGE, "left-pad@1.3.0", undefined);
    expect(args).toEqual([
      "run",
      "--rm",
      "-v",
      "pg-stage-abc:/stage",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "1g",
      "--entrypoint",
      "npm",
      IMAGE,
      "install",
      "--prefix",
      "/stage",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
      "--",
      "left-pad@1.3.0",
    ]);
  });
  it("labels the container when a runLabel is set", () => {
    const args = stageInstallArgs("pg-stage-abc", IMAGE, "left-pad@1.3.0", "run-123");
    expect(args).toContain("--label");
    // the label pair sits among the run flags, before the image
    const li = args.indexOf("--label");
    expect(args[li + 1]).toBe("polygraph-litmus-run=run-123");
    expect(li).toBeLessThan(args.indexOf(IMAGE));
  });
  it("targets a tarball path identically when the spec is a /stage path", () => {
    const args = stageInstallArgs("pg-stage-abc", IMAGE, "/stage/pkg.tgz", undefined);
    expect(args.slice(-2)).toEqual(["--", "/stage/pkg.tgz"]);
  });
  it("omits --runtime when none is given, and applies it (gVisor parity) when set", () => {
    expect(stageInstallArgs("pg-stage-abc", IMAGE, "left-pad", undefined)).not.toContain("--runtime");
    const args = stageInstallArgs("pg-stage-abc", IMAGE, "left-pad", undefined, "runsc");
    const ri = args.indexOf("--runtime");
    expect(ri).toBeGreaterThan(-1);
    expect(args[ri + 1]).toBe("runsc");
    expect(ri).toBeLessThan(args.indexOf(IMAGE)); // runtime flag precedes the image
  });
});

describe("resolverRunArgs", () => {
  it("runs the resolver offline (--network none) as non-root, caps dropped, bounded", () => {
    const args = resolverRunArgs("pg-stage-abc", IMAGE, "left-pad", undefined);
    expect(args).toEqual([
      "run",
      "--rm",
      "-v",
      "pg-stage-abc:/stage",
      "--user",
      "node",
      "--network",
      "none",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "512m",
      "--entrypoint",
      "node",
      IMAGE,
      "-e",
      RESOLVER_SCRIPT,
      "left-pad",
    ]);
  });
  it("denies the resolver any network and bounds pids/memory", () => {
    const args = resolverRunArgs("pg-stage-abc", IMAGE, "left-pad", undefined);
    const s = args.join(" ");
    expect(s).toContain("--network none");
    expect(s).toContain("--pids-limit 256");
    expect(s).toContain("--memory 512m");
  });
  it("labels the resolver container when a runLabel is set", () => {
    const args = resolverRunArgs("pg-stage-abc", IMAGE, "left-pad", "run-123");
    const li = args.indexOf("--label");
    expect(li).toBeGreaterThan(-1);
    expect(args[li + 1]).toBe("polygraph-litmus-run=run-123");
    expect(li).toBeLessThan(args.indexOf(IMAGE));
  });
  it("omits --runtime when none is given, and applies it (gVisor parity) when set", () => {
    expect(resolverRunArgs("pg-stage-abc", IMAGE, "left-pad", undefined)).not.toContain("--runtime");
    const args = resolverRunArgs("pg-stage-abc", IMAGE, "left-pad", undefined, "runsc");
    const ri = args.indexOf("--runtime");
    expect(ri).toBeGreaterThan(-1);
    expect(args[ri + 1]).toBe("runsc");
    expect(ri).toBeLessThan(args.indexOf(IMAGE));
  });
});

describe("RESOLVER_SCRIPT", () => {
  it("reads the package.json under /stage/node_modules/<pkg>", () => {
    expect(RESOLVER_SCRIPT).toContain("/stage/node_modules/");
  });
  it("reports both the resolved bin entry and the version", () => {
    // It prints JSON so a single offline container run yields both bin + version.
    expect(RESOLVER_SCRIPT).toContain("version");
    expect(RESOLVER_SCRIPT).toContain("bin");
    expect(RESOLVER_SCRIPT).toContain("JSON.stringify");
  });
});

describe("parseResolverOutput", () => {
  it("returns the bin map, version, and declared egress from resolver JSON", () => {
    const bins = {
      "polygraphso-litmus": "/stage/node_modules/foo/dist/cli.js",
      "polygraphso-litmus-mcp": "/stage/node_modules/foo/dist/mcp.js",
    };
    const out = JSON.stringify({ bins, version: "1.2.3", declaredEgress: ["polygraph.so", "*.openai.com"] });
    expect(parseResolverOutput(out)).toEqual({ bins, version: "1.2.3", declaredEgress: ["polygraph.so", "*.openai.com"] });
  });
  it("defaults declaredEgress to [] and nulls the version when unreadable", () => {
    const bins = { foo: "/stage/node_modules/foo/cli.js" };
    const out = JSON.stringify({ bins, version: null });
    expect(parseResolverOutput(out)).toEqual({ bins, version: null, declaredEgress: [] });
  });
  it("returns empty bins/egress and null version when there is no bin", () => {
    const out = JSON.stringify({ bins: {}, version: "1.2.3" });
    expect(parseResolverOutput(out)).toEqual({ bins: {}, version: "1.2.3", declaredEgress: [] });
  });
  it("drops non-string bin paths and non-string egress entries; empty on malformed", () => {
    expect(parseResolverOutput("")).toEqual({ bins: {}, version: null, declaredEgress: [] });
    expect(parseResolverOutput("not json")).toEqual({ bins: {}, version: null, declaredEgress: [] });
    const out = JSON.stringify({ bins: { good: "/x", bad: 7 }, version: null, declaredEgress: ["ok.com", 9, null] });
    expect(parseResolverOutput(out)).toEqual({ bins: { good: "/x" }, version: null, declaredEgress: ["ok.com"] });
  });
});

describe("ensureImage", () => {
  it("builds with --pull first and does not retry when that succeeds", async () => {
    const docker = vi.fn<(args: string[], timeoutMs?: number) => Promise<string>>().mockResolvedValue("");
    await ensureImage(docker);
    expect(docker).toHaveBeenCalledTimes(1);
    expect(docker.mock.calls[0]![0]).toContain("--pull");
  });

  it("retries once WITHOUT --pull when the --pull build fails (cached base)", async () => {
    const docker = vi
      .fn<(args: string[], timeoutMs?: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error("docker build failed: pull access denied"))
      .mockResolvedValueOnce("");
    await ensureImage(docker);
    expect(docker).toHaveBeenCalledTimes(2);
    // First attempt pulls; the fallback omits --pull so a cached base suffices.
    expect(docker.mock.calls[0]![0]).toContain("--pull");
    expect(docker.mock.calls[1]![0]).not.toContain("--pull");
    // The build is otherwise identical (same tag + Dockerfile + dir).
    const tagIdx = docker.mock.calls[1]![0].indexOf("-t");
    expect(docker.mock.calls[1]![0][tagIdx + 1]).toBe("polygraph-egress-sniff:latest");
  });

  it("throws when both the --pull build and the cached fallback fail", async () => {
    const docker = vi
      .fn<(args: string[], timeoutMs?: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error("pull failed"))
      .mockRejectedValueOnce(new Error("cached build failed"));
    await expect(ensureImage(docker)).rejects.toThrow(/cached build failed/);
    expect(docker).toHaveBeenCalledTimes(2);
  });

  it("skips --pull and builds the cached base directly when LITMUS_DOCKER_BUILD_PULL=0", async () => {
    const prev = process.env.LITMUS_DOCKER_BUILD_PULL;
    process.env.LITMUS_DOCKER_BUILD_PULL = "0";
    try {
      const docker = vi.fn<(args: string[], timeoutMs?: number) => Promise<string>>().mockResolvedValue("");
      await ensureImage(docker);
      // One build, no registry pull (a long-lived runner refreshes the base out of
      // band — see the daily prune cron — so grading makes no Docker Hub call).
      expect(docker).toHaveBeenCalledTimes(1);
      expect(docker.mock.calls[0]![0]).not.toContain("--pull");
    } finally {
      if (prev === undefined) delete process.env.LITMUS_DOCKER_BUILD_PULL;
      else process.env.LITMUS_DOCKER_BUILD_PULL = prev;
    }
  });
});

describe("tarballCopyContainerArgs", () => {
  it("creates a no-op helper container with the volume mounted at /stage", () => {
    const args = tarballCopyContainerArgs("helper-ctr", "pg-stage-abc", IMAGE, undefined);
    expect(args).toEqual([
      "container",
      "create",
      "--name",
      "helper-ctr",
      "--entrypoint",
      "true",
      "-v",
      "pg-stage-abc:/stage",
      IMAGE,
    ]);
  });
  it("labels the helper container when a runLabel is set", () => {
    const args = tarballCopyContainerArgs("helper-ctr", "pg-stage-abc", IMAGE, "run-123");
    const li = args.indexOf("--label");
    expect(li).toBeGreaterThan(-1);
    expect(args[li + 1]).toBe("polygraph-litmus-run=run-123");
    expect(li).toBeLessThan(args.indexOf(IMAGE));
  });
});
