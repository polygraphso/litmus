import { describe, it, expect } from "vitest";
import { selectClientIdentity, CLIENT_IDENTITY_POOL } from "./client-identity.js";

describe("selectClientIdentity: litmus-v17", () => {
  it("picks a real pool entry when there is no override", () => {
    const identity = selectClientIdentity("npm/@scope/server", {});
    expect(CLIENT_IDENTITY_POOL).toContainEqual(identity);
  });

  it("is deterministic: the same seed always resolves to the same identity", () => {
    for (const seed of ["npm/@scope/server", "https://example.com/mcp", "pypi/some-pkg"]) {
      const first = selectClientIdentity(seed, {});
      for (let i = 0; i < 20; i++) {
        expect(selectClientIdentity(seed, {})).toEqual(first);
      }
    }
  });

  it("different seeds can resolve to different identities (spreads across the pool)", () => {
    const picks = new Set(
      Array.from({ length: 30 }, (_, i) => selectClientIdentity(`target-${i}`, {}).name),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it("LITMUS_CLIENT_NAME overrides the pool outright", () => {
    const identity = selectClientIdentity("npm/@scope/server", { LITMUS_CLIENT_NAME: "my-custom-agent" });
    expect(identity.name).toBe("my-custom-agent");
    expect(identity.version).toBe("1.0.0");
  });

  it("LITMUS_CLIENT_VERSION pairs with LITMUS_CLIENT_NAME when both are set", () => {
    const identity = selectClientIdentity("npm/@scope/server", {
      LITMUS_CLIENT_NAME: "my-custom-agent",
      LITMUS_CLIENT_VERSION: "9.9.9",
    });
    expect(identity).toEqual({ name: "my-custom-agent", version: "9.9.9" });
  });

  it("never returns the old fixed harness identity", () => {
    for (const seed of ["npm/a", "npm/b", "https://x.example/mcp", "pypi/c", "github/o/r"]) {
      expect(selectClientIdentity(seed, {}).name).not.toBe("polygraph-litmus");
    }
  });
});
