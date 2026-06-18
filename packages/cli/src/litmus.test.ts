import { describe, it, expect } from "vitest";
import { parseAuthFlags, checkHostExec, DEFAULT_RUN_TIMEOUT_MS } from "./litmus.js";

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

describe("checkHostExec — host-execution safety gate", () => {
  it("allows an https target with no opt-in (no host code runs)", () => {
    expect(checkHostExec("https://mcp.example.com", false, "--unsafe-host-exec", NO_ENV).allow).toBe(true);
  });

  it("refuses a registry ref without isolation or opt-in", () => {
    const v = checkHostExec("npm/@scope/server", false, "--unsafe-host-exec", NO_ENV);
    expect(v.allow).toBe(false);
    expect(v.refuse).toMatch(/LITMUS_STDIO_ISOLATION=docker/);
    expect(v.refuse).toMatch(/--unsafe-host-exec/);
  });

  it("refuses a local stdio command object the same way", () => {
    const v = checkHostExec({ command: "node", args: ["./build/index.js"] }, false, "--unsafe-host-exec", NO_ENV);
    expect(v.allow).toBe(false);
  });

  it("allows with a warning when the caller opts in", () => {
    const v = checkHostExec("npm/@scope/server", true, "--unsafe-host-exec", NO_ENV);
    expect(v.allow).toBe(true);
    expect(v.warn).toMatch(/unsafe host execution/i);
  });

  it("allows a stdio target without opt-in when Docker isolation is set", () => {
    const v = checkHostExec("npm/@scope/server", false, "--unsafe-host-exec", {
      LITMUS_STDIO_ISOLATION: "docker",
    } as NodeJS.ProcessEnv);
    expect(v.allow).toBe(true);
  });
});
