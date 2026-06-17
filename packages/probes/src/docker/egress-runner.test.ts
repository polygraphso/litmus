import { describe, it, expect } from "vitest";
import { parseSinkholeOutput, egressToFindings, egressCanaryFindings, egressTargetArgs, egressSleeperArgs } from "./egress-runner.js";

const TARGET_BASE = {
  targetName: "pg-target-abcd1234",
  net: "pg-egress-abcd1234",
  sinkIp: "172.18.0.2",
  vol: "pg-stage-abcd1234",
  entry: "/stage/node_modules/leaky-mcp/index.js",
  canaryEnv: { OPENAI_API_KEY: "POLYGRAPH-CANARY-x" },
  label: ["--label", "polygraph-litmus-run=run-1"],
};

/** Index of the value immediately following `flag` in `args`. */
function followingValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("egressTargetArgs — C-02 target container arg builder", () => {
  it("carries the audited C-02 hardening flags and the entry last", () => {
    const args = egressTargetArgs(TARGET_BASE);
    const s = args.join(" ");
    expect(args[0]).toBe("run");
    expect(args).toContain("-i");
    expect(args).toContain("--rm");
    expect(s).toContain("--user node");
    expect(s).toContain("--read-only");
    expect(s).toContain("--cap-drop=ALL");
    expect(s).toContain("--security-opt no-new-privileges");
    expect(s).toContain("--pids-limit 256");
    expect(s).toContain("--memory 512m");
    expect(s).toContain("--cpus 1");
    expect(s).toContain("--dns 172.18.0.2");
    expect(s).toContain("--sysctl net.ipv6.conf.all.disable_ipv6=1");
    // /tmp tmpfs is size-capped, matching the main-connect target (container.ts) —
    // an uncapped writable tmpfs is a host-memory-exhaustion primitive.
    expect(s).toContain("--tmpfs /tmp:rw,size=64m,mode=1777");
    expect(args[args.length - 1]).toBe(TARGET_BASE.entry);
  });

  it("omits --runtime when none is given", () => {
    expect(egressTargetArgs(TARGET_BASE)).not.toContain("--runtime");
  });

  it("includes --runtime <runtime> when given (gVisor parity with the main-connect target)", () => {
    const args = egressTargetArgs({ ...TARGET_BASE, runtime: "runsc" });
    expect(followingValue(args, "--runtime")).toBe("runsc");
    // runtime sits before --entrypoint (and so before the image + entry).
    expect(args.indexOf("--runtime")).toBeLessThan(args.indexOf("--entrypoint"));
  });

  it("emits one -e KEY=VALUE per canary entry", () => {
    const args = egressTargetArgs(TARGET_BASE);
    const envValues = args.filter((_, i) => args[i - 1] === "-e");
    expect(envValues).toEqual(["OPENAI_API_KEY=POLYGRAPH-CANARY-x"]);
  });
});

describe("egressSleeperArgs — gateway-mode target sleeper", () => {
  const SLEEPER_BASE = {
    targetName: "pg-target-abcd1234",
    net: "pg-egw-abcd1234",
    sinkIp: "172.18.0.2",
    vol: "pg-stage-abcd1234",
    label: ["--label", "polygraph-litmus-run=run-1"],
  };

  it("keeps the audited hardening but runs `sleep` (server starts later via exec)", () => {
    const args = egressSleeperArgs(SLEEPER_BASE);
    const s = args.join(" ");
    expect(args.slice(0, 2)).toEqual(["run", "-d"]); // detached sleeper, not `run -i`
    expect(s).toContain("--user node");
    expect(s).toContain("--read-only");
    expect(s).toContain("--cap-drop=ALL"); // target never gets caps; the sidecar does
    expect(s).toContain("--security-opt no-new-privileges");
    expect(s).toContain("--dns 172.18.0.2");
    expect(s).toContain("--sysctl net.ipv6.conf.all.disable_ipv6=1");
    expect(s).toContain("--tmpfs /tmp:rw,size=64m,mode=1777");
    expect(args.slice(-4)).toEqual(["--entrypoint", "sleep", "polygraph-egress-sniff:latest", "3600"]);
  });

  it("runs the sleep entrypoint and carries NO canary -e (canaries seed the exec)", () => {
    const args = egressSleeperArgs(SLEEPER_BASE);
    expect(args).toContain("--entrypoint");
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("sleep");
    expect(args[args.length - 1]).toBe("3600"); // bounded sleep backstop
    expect(args).not.toContain("-e"); // canaries are seeded on the exec, not the sleeper
  });

  it("includes --runtime when given (gVisor parity, sidecar joins the same netstack)", () => {
    const args = egressSleeperArgs({ ...SLEEPER_BASE, runtime: "runsc" });
    expect(followingValue(args, "--runtime")).toBe("runsc");
  });
});

describe("parseSinkholeOutput", () => {
  it("parses EGRESS json lines and ignores everything else", () => {
    const out = [
      "EGRESS-SINK ready",
      'EGRESS {"kind":"dns","host":"evil.example"}',
      'EGRESS {"kind":"tcp","host":"evil.example","port":443,"firstBytes":"GET /steal"}',
      "some unrelated container log",
      "EGRESS {not valid json}",
    ].join("\n");
    const attempts = parseSinkholeOutput(out);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ kind: "dns", host: "evil.example" });
    expect(attempts[1]).toMatchObject({ kind: "tcp", port: 443, host: "evil.example" });
  });
});

describe("egressToFindings", () => {
  it("maps attempts to high-severity egress findings", () => {
    const f = egressToFindings([{ kind: "tcp", host: "evil.example", port: 443, firstBytes: "x" }]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "egress", severity: "high", host: "evil.example", port: 443 });
    expect(f[0]!.match).toContain("evil.example");
  });
});

describe("egressCanaryFindings", () => {
  it("flags a canary that left over the network", () => {
    const f = egressCanaryFindings(
      [{ kind: "tcp", firstBytes: "POST /collect?key=POLYGRAPH-CANARY-abc" }],
      ["POLYGRAPH-CANARY-abc"],
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe("canary");
  });
  it("is clean when no canary appears", () => {
    expect(egressCanaryFindings([{ kind: "tcp", firstBytes: "GET /" }], ["POLYGRAPH-CANARY-abc"])).toHaveLength(0);
  });
});
