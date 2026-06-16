import { describe, it, expect } from "vitest";
import { resolveStagedVersion, isConcreteVersion } from "./version.js";

/**
 * The recorded version for an isolated npm grade is the version the resolver read
 * from the installed package.json — NEVER the requested pin, which is unverified
 * until install. A concrete-version pin that doesn't match what was actually
 * installed fails closed (the grade must not mislabel the version); a range or
 * dist-tag pin legitimately resolves to a concrete version and is not a mismatch.
 */

describe("isConcreteVersion", () => {
  it("treats x.y.z (and prerelease) as concrete", () => {
    expect(isConcreteVersion("1.2.3")).toBe(true);
    expect(isConcreteVersion("4.17.21")).toBe(true);
    expect(isConcreteVersion("1.2.3-beta.1")).toBe(true);
  });

  it("treats dist-tags and partial versions as NOT concrete", () => {
    expect(isConcreteVersion("latest")).toBe(false);
    expect(isConcreteVersion("beta")).toBe(false);
    expect(isConcreteVersion("1")).toBe(false);
    expect(isConcreteVersion("1.2")).toBe(false);
  });
});

describe("resolveStagedVersion", () => {
  it("records the staged (actually-installed) version, not the requested pin", () => {
    expect(resolveStagedVersion("1.2.3", "1.2.3")).toBe("1.2.3");
    // unpinned ref: staged is the source of truth
    expect(resolveStagedVersion(null, "1.2.3")).toBe("1.2.3");
  });

  it("throws when a concrete pin differs from what was installed (fail closed)", () => {
    expect(() => resolveStagedVersion("1.2.3", "1.2.4")).toThrow(/requested.*1\.2\.3.*staged.*1\.2\.4/);
  });

  it("does NOT throw for a range/dist-tag pin that resolved to a concrete version", () => {
    expect(resolveStagedVersion("latest", "1.2.3")).toBe("1.2.3");
    expect(resolveStagedVersion("1", "1.9.0")).toBe("1.9.0");
    expect(resolveStagedVersion("1.2", "1.2.7")).toBe("1.2.7");
  });

  it("degrades to null when the resolver could not read a version (no throw)", () => {
    // Even with a concrete pin: we couldn't verify the install, so record null
    // honestly rather than recording the unverified requested pin.
    expect(resolveStagedVersion("1.2.3", null)).toBeNull();
    expect(resolveStagedVersion(null, null)).toBeNull();
  });
});
