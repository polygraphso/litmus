import { describe, it, expect } from "vitest";
import { parseAuthFlags, parseServerEnvPairs, checkHostExec, isAffirmative, DEFAULT_RUN_TIMEOUT_MS } from "./litmus.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

describe("parseAuthFlags — target extraction", () => {
  it("returns the positional target and ignores --json", () => {
    const { positionals } = parseAuthFlags(["--json", "npm/@scope/x"], NO_ENV);
    expect(positionals).toEqual(["npm/@scope/x"]);
  });

  it("does not mistake a --bearer value for the target", () => {
    const { positionals, headers } = parseAuthFlags(
      ["--bearer", "tok-123", "https://mcp.example.com"],
      NO_ENV,
    );
    expect(positionals).toEqual(["https://mcp.example.com"]);
    expect(headers.Authorization).toBe("Bearer tok-123");
  });

  it("ignores unknown flags rather than treating them as the target", () => {
    const { positionals } = parseAuthFlags(["--definitely-unknown", "https://x.example"], NO_ENV);
    expect(positionals).toEqual(["https://x.example"]);
  });
});

describe("parseAuthFlags — Authorization precedence", () => {
  it("LITMUS_BEARER seeds the Authorization header", () => {
    const { headers } = parseAuthFlags(["https://x"], { LITMUS_BEARER: "env-tok" } as NodeJS.ProcessEnv);
    expect(headers.Authorization).toBe("Bearer env-tok");
  });

  it("--bearer overrides LITMUS_BEARER", () => {
    const { headers } = parseAuthFlags(["--bearer", "flag-tok", "https://x"], {
      LITMUS_BEARER: "env-tok",
    } as NodeJS.ProcessEnv);
    expect(headers.Authorization).toBe("Bearer flag-tok");
  });

  it("--header overrides --bearer for the same key", () => {
    const { headers } = parseAuthFlags(
      ["--bearer", "flag-tok", "--header", "Authorization: Bearer raw", "https://x"],
      NO_ENV,
    );
    expect(headers.Authorization).toBe("Bearer raw");
  });

  it("supports --bearer=… and --header=… forms and multiple headers", () => {
    const { headers } = parseAuthFlags(
      ["--bearer=t", "--header=X-Org: acme", "--header", "X-Env: prod", "https://x"],
      NO_ENV,
    );
    expect(headers.Authorization).toBe("Bearer t");
    expect(headers["X-Org"]).toBe("acme");
    expect(headers["X-Env"]).toBe("prod");
  });

  it("yields no headers when nothing is supplied", () => {
    const { headers } = parseAuthFlags(["https://x"], NO_ENV);
    expect(Object.keys(headers)).toHaveLength(0);
  });

  it("skips a malformed --header with no colon", () => {
    const { headers } = parseAuthFlags(["--header", "notaheader", "https://x"], NO_ENV);
    expect(Object.keys(headers)).toHaveLength(0);
  });
});

describe("parseAuthFlags — state-changing opt-in", () => {
  it("defaults off and flips on with --allow-state-changing", () => {
    expect(parseAuthFlags(["https://x"], NO_ENV).allowStateChanging).toBe(false);
    expect(parseAuthFlags(["--allow-state-changing", "https://x"], NO_ENV).allowStateChanging).toBe(true);
  });
});

describe("parseAuthFlags — host-exec opt-in + timeout", () => {
  it("defaults unsafeHostExec off and flips on with --unsafe-host-exec", () => {
    expect(parseAuthFlags(["npm/x"], NO_ENV).unsafeHostExec).toBe(false);
    expect(parseAuthFlags(["--unsafe-host-exec", "npm/x"], NO_ENV).unsafeHostExec).toBe(true);
  });

  it("defaults to the 15-min timeout and parses --timeout <seconds> without eating the target", () => {
    expect(parseAuthFlags(["npm/x"], NO_ENV).timeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
    const parsed = parseAuthFlags(["--timeout", "30", "npm/x"], NO_ENV);
    expect(parsed.timeoutMs).toBe(30_000);
    expect(parsed.positionals).toEqual(["npm/x"]); // value consumed, not misread as target
  });

  it("supports --timeout=<seconds> and falls back to the default on a bad value", () => {
    expect(parseAuthFlags(["--timeout=60", "npm/x"], NO_ENV).timeoutMs).toBe(60_000);
    expect(parseAuthFlags(["--timeout", "nope", "npm/x"], NO_ENV).timeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });
});

describe("parseAuthFlags — dependency-audit opt-out", () => {
  it("defaults the dependency audit on and turns it off with --no-deps-audit", () => {
    expect(parseAuthFlags(["npm/x"], NO_ENV).depsAudit).toBe(true);
    const parsed = parseAuthFlags(["--no-deps-audit", "npm/x"], NO_ENV);
    expect(parsed.depsAudit).toBe(false);
    expect(parsed.positionals).toEqual(["npm/x"]); // flag not misread as the target
  });

  it("honors LITMUS_DEPS_AUDIT=0 as an opt-out", () => {
    expect(parseAuthFlags(["npm/x"], { LITMUS_DEPS_AUDIT: "0" } as NodeJS.ProcessEnv).depsAudit).toBe(false);
    expect(parseAuthFlags(["npm/x"], { LITMUS_DEPS_AUDIT: "1" } as NodeJS.ProcessEnv).depsAudit).toBe(true);
  });
});

describe("parseAuthFlags — non-bare launch flags", () => {
  it("defaults to no launch config", () => {
    const p = parseAuthFlags(["npm/x"], NO_ENV);
    expect(p.serverArgs).toEqual([]);
    expect(p.serverEnv).toEqual({});
    expect(p.entrySubpath).toBeUndefined();
  });

  it("collects repeated --server-arg in order, without misreading the target", () => {
    const p = parseAuthFlags(["--server-arg", "mcp", "--server-arg", "serve", "npm/x"], NO_ENV);
    expect(p.serverArgs).toEqual(["mcp", "serve"]);
    expect(p.positionals).toEqual(["npm/x"]);
  });

  it("consumes a --server-arg value that begins with '-' (not treated as a flag)", () => {
    const p = parseAuthFlags(["--server-arg", "--stdio", "npm/x"], NO_ENV);
    expect(p.serverArgs).toEqual(["--stdio"]);
    expect(p.positionals).toEqual(["npm/x"]);
  });

  it("accepts the --server-arg=VALUE form", () => {
    const p = parseAuthFlags(["--server-arg=serve", "npm/x"], NO_ENV);
    expect(p.serverArgs).toEqual(["serve"]);
  });

  it("collects repeated --server-env KEY=VALUE into a record", () => {
    const p = parseAuthFlags(["--server-env", "A=1", "--server-env=B=2", "npm/x"], NO_ENV);
    expect(p.serverEnv).toEqual({ A: "1", B: "2" });
    expect(p.positionals).toEqual(["npm/x"]);
  });

  it("captures --entry and --entry=VALUE, without misreading the target", () => {
    expect(parseAuthFlags(["--entry", "mcp/server.mjs", "npm/x"], NO_ENV).entrySubpath).toBe("mcp/server.mjs");
    const eq = parseAuthFlags(["--entry=dist/index.js", "npm/x"], NO_ENV);
    expect(eq.entrySubpath).toBe("dist/index.js");
    expect(eq.positionals).toEqual(["npm/x"]);
  });
});

describe("parseServerEnvPairs", () => {
  it("splits KEY=VALUE on the first '='", () => {
    expect(parseServerEnvPairs(["A=1", "TOKEN=x=y=z"])).toEqual({ A: "1", TOKEN: "x=y=z" });
  });

  it("skips a pair with no '=' or an empty key", () => {
    expect(parseServerEnvPairs(["novalue", "=orphan", "OK=1"])).toEqual({ OK: "1" });
  });

  it("allows an empty value", () => {
    expect(parseServerEnvPairs(["EMPTY="])).toEqual({ EMPTY: "" });
  });
});

describe("checkHostExec — host-execution safety gate", () => {
  const gate = (over: Partial<Parameters<typeof checkHostExec>[1]> = {}) => ({
    optIn: false,
    dockerAvailable: false,
    interactive: false,
    env: NO_ENV,
    ...over,
  });

  it("allows an https target with no host code", () => {
    const d = checkHostExec("https://mcp.example.com", gate({ interactive: true, dockerAvailable: true }));
    expect(d.action).toBe("allow");
  });

  it("allows under Docker isolation set via env, with isolation docker", () => {
    const d = checkHostExec("npm/@scope/server", gate({ env: { LITMUS_STDIO_ISOLATION: "docker" } as NodeJS.ProcessEnv }));
    expect(d).toMatchObject({ action: "allow", isolation: "docker" });
  });

  it("allows host execution with a warning when the caller opts in", () => {
    const d = checkHostExec("npm/@scope/server", gate({ optIn: true }));
    expect(d).toMatchObject({ action: "allow", isolation: "none" });
    expect(d.action === "allow" && d.warn).toMatch(/unsafe host execution/i);
  });

  it("refuses a registry ref when non-interactive (CI / MCP pipe) with no opt-in", () => {
    const d = checkHostExec("npm/@scope/server", gate());
    expect(d.action).toBe("refuse");
    if (d.action !== "refuse") throw new Error("unreachable");
    expect(d.refuse).toMatch(/LITMUS_STDIO_ISOLATION=docker/);
    expect(d.refuse).toMatch(/--unsafe-host-exec/);
  });

  it("refuses a local stdio command object the same way when non-interactive", () => {
    const d = checkHostExec({ command: "node", args: ["./build/index.js"] }, gate());
    expect(d.action).toBe("refuse");
  });

  it("asks to confirm the Docker sandbox when interactive and Docker is available", () => {
    const d = checkHostExec("npm/@scope/server", gate({ interactive: true, dockerAvailable: true }));
    expect(d).toMatchObject({ action: "confirm", isolation: "docker", defaultYes: true });
    if (d.action !== "confirm") throw new Error("unreachable");
    expect(d.prompt).toMatch(/Docker/i);
  });

  it("asks to confirm host execution (type yes) when interactive and Docker is absent", () => {
    const d = checkHostExec("npm/@scope/server", gate({ interactive: true, dockerAvailable: false }));
    expect(d).toMatchObject({ action: "confirm", isolation: "none", defaultYes: false });
    if (d.action !== "confirm") throw new Error("unreachable");
    expect(d.prompt).toMatch(/host/i);
    expect(d.prompt).toMatch(/yes/i);
  });
});

describe("isAffirmative", () => {
  it("treats empty input as the default", () => {
    expect(isAffirmative("", true)).toBe(true);
    expect(isAffirmative("  ", false)).toBe(false);
  });

  it("accepts y / yes case-insensitively", () => {
    for (const a of ["y", "Y", "yes", "YES", " Yes "]) expect(isAffirmative(a, false)).toBe(true);
  });

  it("rejects anything else", () => {
    for (const a of ["n", "no", "nope", "x", "1"]) expect(isAffirmative(a, true)).toBe(false);
  });
});
