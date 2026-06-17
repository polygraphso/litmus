import { describe, it, expect } from "vitest";
import { parseSinkholeOutput, egressToFindings, egressCanaryFindings, egressTargetArgs, hostDnatCommands, hostDnatHelperArgs } from "./egress-runner.js";

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

describe("hostDnatCommands — gateway host-DNAT rules", () => {
  const SCOPE = { bridge: "br-1d8aba10d356", subnet: "172.18.0.0/16", sinkIp: "172.18.0.2" };

  it("inserts the three capture rules scoped to the run's bridge", () => {
    const cmds = hostDnatCommands("I", SCOPE);
    expect(cmds).toHaveLength(3);
    // DNAT off-subnet TCP from THIS bridge → sink:8443
    expect(cmds[0]).toBe("iptables -t nat -I PREROUTING 1 -i br-1d8aba10d356 -p tcp ! -d 172.18.0.0/16 -j DNAT --to-destination 172.18.0.2:8443");
    // MASQUERADE so the sink's reply returns via the host (the handshake-completing fix)
    expect(cmds[1]).toBe("iptables -t nat -I POSTROUTING 1 -o br-1d8aba10d356 -p tcp -d 172.18.0.2 --dport 8443 -j MASQUERADE");
    // FORWARD hairpin
    expect(cmds[2]).toBe("iptables -I FORWARD 1 -i br-1d8aba10d356 -o br-1d8aba10d356 -j ACCEPT");
  });

  it("the delete set mirrors the insert set exactly (symmetric add/remove)", () => {
    const ins = hostDnatCommands("I", SCOPE);
    const del = hostDnatCommands("D", SCOPE);
    expect(del).toHaveLength(3);
    // Each delete is its insert with `-I <chain> 1` → `-D <chain>` and nothing else changed.
    for (let i = 0; i < ins.length; i++) {
      expect(del[i]).toBe(ins[i]!.replace(/ -I (PREROUTING|POSTROUTING|FORWARD) 1 /, " -D $1 "));
    }
  });

  it("every rule is scoped to the run's own bridge (can't touch another grade)", () => {
    for (const cmd of hostDnatCommands("I", SCOPE)) expect(cmd).toContain("br-1d8aba10d356");
  });
});

describe("hostDnatHelperArgs — ephemeral host-iptables helper", () => {
  const SCOPE = { bridge: "br-abc", subnet: "10.0.0.0/24", sinkIp: "10.0.0.2" };

  it("runs --network host with NET_ADMIN only (everything else dropped) over fixed commands", () => {
    const args = hostDnatHelperArgs("I", SCOPE, ["--label", "polygraph-litmus-run=run-1"]);
    const s = args.join(" ");
    expect(s).toContain("--network host"); // must reach the host netfilter
    expect(s).toContain("--cap-add=NET_ADMIN");
    expect(s).toContain("--cap-drop=ALL"); // minimal privilege: NET_ADMIN and nothing else
    expect(s).toContain("--rm");
    expect(s).toContain("--label polygraph-litmus-run=run-1");
    // the helper runs ONLY our fixed iptables script — no untrusted input
    expect(args[args.length - 1]).toBe(hostDnatCommands("I", SCOPE).join("; "));
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
