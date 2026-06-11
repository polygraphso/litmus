import { describe, it, expect } from "vitest";
import { parseAuthFlags } from "./litmus.js";

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
