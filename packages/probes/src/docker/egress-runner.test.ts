import { describe, it, expect } from "vitest";
import { parseSinkholeOutput, egressToFindings, egressCanaryFindings } from "./egress-runner.js";

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
