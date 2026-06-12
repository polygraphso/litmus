import { describe, it, expect } from "vitest";
import { containerLaunch, recordedContainerCommand } from "./container.js";

/**
 * Pure assertions on the main-connect container arg builder. The flag set is
 * locked in plans/hosted-service.md §2.6: this test pins every flag, the
 * read-only mounts, the tmpfs size cap, the run label, one `-e K=V` per canary
 * entry, conditional `--runtime`, and the entry path last — so a silent
 * weakening of the sandbox shows up as a failing test, not a quiet regression.
 */

const BASE = {
  entry: "/stage/node_modules/leaky-bin-mcp/index.js",
  stageVolume: "pg-stage-abcd1234",
  seedVolume: "pg-seed-abcd1234",
  canaryEnv: {
    OPENAI_API_KEY: "POLYGRAPH-CANARY-x",
    GITHUB_TOKEN: "pgt_y",
  },
  runLabel: "live-test-1234",
};

/** Index of `b` in `args` that immediately follows `a` (i.e. a flag/value pair). */
function followingValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("containerLaunch — main-connect container arg builder (§2.6)", () => {
  it("emits docker as the command", () => {
    const { command } = containerLaunch(BASE);
    expect(command).toBe("docker");
  });

  it("includes every §2.6 hardening flag", () => {
    const { args } = containerLaunch(BASE);
    const s = args.join(" ");
    expect(args[0]).toBe("run");
    expect(args).toContain("-i");
    expect(args).toContain("--rm");
    expect(s).toContain("--network none");
    expect(s).toContain("--user node");
    expect(args).toContain("--read-only");
    expect(s).toContain("-w /work");
    expect(s).toContain("--cap-drop=ALL");
    expect(s).toContain("--security-opt no-new-privileges");
    expect(s).toContain("--pids-limit 256");
    expect(s).toContain("--memory 512m");
    expect(s).toContain("--cpus 1");
    expect(s).toContain("--sysctl net.ipv6.conf.all.disable_ipv6=1");
    expect(s).toContain("--sysctl net.ipv6.conf.default.disable_ipv6=1");
    expect(s).toContain("--entrypoint node");
    expect(args).toContain("polygraph-egress-sniff:latest");
  });

  it("mounts BOTH the stage and seed volumes READ-ONLY", () => {
    const { args } = containerLaunch(BASE);
    const mounts = args.filter((_, i) => args[i - 1] === "-v");
    expect(mounts).toContain(`${BASE.stageVolume}:/stage:ro`);
    expect(mounts).toContain(`${BASE.seedVolume}:/work:ro`);
    // Every -v mount must end in :ro — no writable disk-backed volume.
    for (const m of mounts) expect(m.endsWith(":ro")).toBe(true);
  });

  it("size-caps the /tmp tmpfs (no unbounded host-disk write)", () => {
    const { args } = containerLaunch(BASE);
    expect(followingValue(args, "--tmpfs")).toBe("/tmp:rw,size=64m,mode=1777");
  });

  it("carries the run label so a killed parent can sweep", () => {
    const { args } = containerLaunch(BASE);
    expect(followingValue(args, "--label")).toBe(`polygraph-litmus-run=${BASE.runLabel}`);
  });

  it("emits exactly one -e KEY=VALUE per canary entry (canaries travel via -e, not the CLI env)", () => {
    const { args } = containerLaunch(BASE);
    const envValues = args.filter((_, i) => args[i - 1] === "-e");
    expect(envValues).toEqual(["OPENAI_API_KEY=POLYGRAPH-CANARY-x", "GITHUB_TOKEN=pgt_y"]);
  });

  it("omits --runtime when none is given", () => {
    const { args } = containerLaunch(BASE);
    expect(args).not.toContain("--runtime");
  });

  it("includes --runtime <runtime> when given (gVisor passthrough)", () => {
    const { args } = containerLaunch({ ...BASE, runtime: "runsc" });
    expect(followingValue(args, "--runtime")).toBe("runsc");
    // runtime sits before --entrypoint per §2.6 ordering.
    expect(args.indexOf("--runtime")).toBeLessThan(args.indexOf("--entrypoint"));
  });

  it("omits the label flag when no runLabel is given", () => {
    const { runLabel, ...noLabel } = BASE;
    void runLabel;
    const { args } = containerLaunch(noLabel);
    expect(args).not.toContain("--label");
  });

  it("puts the entry path last", () => {
    const { args } = containerLaunch(BASE);
    expect(args[args.length - 1]).toBe(BASE.entry);
  });

  it("rejects an entry containing whitespace (defense in depth)", () => {
    expect(() => containerLaunch({ ...BASE, entry: "/stage/evil entry.js" })).toThrow();
  });

  it("rejects an entry with a leading '-' (cannot be read as a flag)", () => {
    expect(() => containerLaunch({ ...BASE, entry: "--rm" })).toThrow();
  });

  it("rejects a volume name containing whitespace", () => {
    expect(() => containerLaunch({ ...BASE, stageVolume: "pg stage" })).toThrow();
    expect(() => containerLaunch({ ...BASE, seedVolume: "pg seed" })).toThrow();
  });

  it("rejects a volume name with a leading '-'", () => {
    expect(() => containerLaunch({ ...BASE, stageVolume: "-vol" })).toThrow();
  });
});

describe("recordedContainerCommand — stable descriptor for the evidence bundle", () => {
  // The recorded command must carry NO secret-shaped value and NO per-run-random
  // volume name — every published hosted_runs.evidence stores this string.
  const stageVol = "pg-stage-9f3a1b2c";
  const seedVol = "pg-seed-7e1d4c5b";
  const built = containerLaunch({ ...BASE, stageVolume: stageVol, seedVolume: seedVol });
  const recorded = recordedContainerCommand(built.command, built.args, {
    stageVolume: stageVol,
    seedVolume: seedVol,
  });

  it("drops every canary -e KEY=VALUE pair (no synthetic per-run secret stored)", () => {
    expect(recorded).not.toContain("-e ");
    expect(recorded).not.toContain("POLYGRAPH-CANARY");
    expect(recorded).not.toContain("OPENAI_API_KEY");
    expect(recorded).not.toContain("pgt_y");
  });

  it("replaces the random volume names with stable <stage>/<seed> placeholders", () => {
    expect(recorded).not.toContain(stageVol);
    expect(recorded).not.toContain(seedVol);
    expect(recorded).toContain("<stage>:/stage:ro");
    expect(recorded).toContain("<seed>:/work:ro");
  });

  it("is deterministic across runs (different volume UUIDs → identical string)", () => {
    const otherStage = "pg-stage-deadbeef";
    const otherSeed = "pg-seed-cafef00d";
    const built2 = containerLaunch({ ...BASE, stageVolume: otherStage, seedVolume: otherSeed });
    const recorded2 = recordedContainerCommand(built2.command, built2.args, {
      stageVolume: otherStage,
      seedVolume: otherSeed,
    });
    expect(recorded2).toBe(recorded);
  });

  it("keeps the docker command and the non-secret hardening flags + entry", () => {
    expect(recorded.startsWith("docker run -i --rm")).toBe(true);
    expect(recorded).toContain("--network none");
    expect(recorded).toContain("--entrypoint node");
    expect(recorded.endsWith(BASE.entry)).toBe(true);
  });
});
