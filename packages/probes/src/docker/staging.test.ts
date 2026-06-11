import { describe, it, expect } from "vitest";
import {
  RESOLVER_SCRIPT,
  labelFlags,
  volumeCreateArgs,
  stageInstallArgs,
  resolverRunArgs,
  tarballCopyContainerArgs,
  parseResolverOutput,
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
  it("returns the entry and resolvedVersion from resolver JSON", () => {
    const out = JSON.stringify({ entry: "/stage/node_modules/foo/cli.js", version: "1.2.3" });
    expect(parseResolverOutput(out)).toEqual({ entry: "/stage/node_modules/foo/cli.js", version: "1.2.3" });
  });
  it("nulls the version when unreadable but keeps the entry", () => {
    const out = JSON.stringify({ entry: "/stage/node_modules/foo/cli.js", version: null });
    expect(parseResolverOutput(out)).toEqual({ entry: "/stage/node_modules/foo/cli.js", version: null });
  });
  it("returns a null entry and null version when there is no bin", () => {
    const out = JSON.stringify({ entry: null, version: "1.2.3" });
    expect(parseResolverOutput(out)).toEqual({ entry: null, version: "1.2.3" });
  });
  it("returns nulls for empty or malformed output", () => {
    expect(parseResolverOutput("")).toEqual({ entry: null, version: null });
    expect(parseResolverOutput("not json")).toEqual({ entry: null, version: null });
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
