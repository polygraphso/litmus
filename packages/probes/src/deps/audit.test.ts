import { describe, it, expect, vi } from "vitest";
import { auditDependencies, parseLockfile } from "./audit.js";

// A lockfile-v3 fixture: a root entry (must be excluded), two top-level deps, a
// nested duplicate of `ws` (must be deduped on name@version), and a scoped pkg
// (name must keep its `@scope/` prefix). Insertion order is the audit order.
const LOCKFILE_V3 = JSON.stringify({
  name: "root",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: {
    "": { name: "root", version: "1.0.0" },
    "node_modules/ws": { version: "8.17.1" },
    "node_modules/lodash": { version: "4.17.20" },
    "node_modules/lodash/node_modules/ws": { version: "8.17.1" }, // dup → deduped
    "node_modules/@scope/pkg": { version: "2.0.0" },
  },
});

/** Build a fetch stub that routes OSV `querybatch` POSTs and `vulns/{id}` GETs. */
function osvStub(batch: unknown, vulns: Record<string, unknown> = {}): typeof fetch {
  return vi.fn(async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    const ok = (body: unknown) =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (u.includes("/querybatch") && init?.method === "POST") return ok(batch);
    const m = u.match(/\/vulns\/([^/?]+)/);
    if (m) {
      const v = vulns[decodeURIComponent(m[1] ?? "")];
      if (v) return ok(v);
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe("parseLockfile", () => {
  it("flattens a v3 lockfile to a deduped, root-excluded {name,version} list in order", () => {
    const deps = parseLockfile(LOCKFILE_V3);
    expect(deps).toEqual([
      { name: "ws", version: "8.17.1" },
      { name: "lodash", version: "4.17.20" },
      { name: "@scope/pkg", version: "2.0.0" },
    ]);
  });

  it("returns an empty list for an unparseable lockfile", () => {
    expect(parseLockfile("not json")).toEqual([]);
  });
});

describe("auditDependencies — applicability", () => {
  it.each(["pypi/x@1", "github/o/r@1", "https://example.com/mcp"])(
    "skips non-npm target %s without touching the network",
    async (target) => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const audit = await auditDependencies(target, { fetchImpl });
      expect(audit.status).toBe("skipped");
      expect(audit.reason).toBeTruthy();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("skips a local stdio command target", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const audit = await auditDependencies(
      { command: "node", args: ["server.js"] },
      { fetchImpl },
    );
    expect(audit.status).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("auditDependencies — OSV mapping", () => {
  it("maps results to advisories, sorted by severity, with fixedIn/url and counts", async () => {
    // querybatch results are positional to the deps order [ws, lodash, @scope/pkg].
    const fetchImpl = osvStub(
      {
        results: [
          { vulns: [{ id: "GHSA-high" }] }, // ws
          {}, // lodash — clean
          { vulns: [{ id: "GHSA-crit" }] }, // @scope/pkg
        ],
      },
      {
        "GHSA-high": {
          id: "GHSA-high",
          summary: "high ws bug",
          database_specific: { severity: "HIGH" },
          affected: [{ package: { name: "ws" }, ranges: [{ events: [{ fixed: "8.21.0" }] }] }],
          references: [{ type: "ADVISORY", url: "https://example/high" }],
        },
        "GHSA-crit": {
          id: "GHSA-crit",
          summary: "critical pkg bug",
          database_specific: { severity: "CRITICAL" },
          references: [],
        },
      },
    );
    const audit = await auditDependencies("npm/demo@1.0.0", {
      existingLockfile: LOCKFILE_V3,
      fetchImpl,
      now: () => "2026-06-23T00:00:00.000Z",
    });

    expect(audit.status).toBe("ok");
    expect(audit.source).toBe("osv.dev");
    expect(audit.ecosystem).toBe("npm");
    expect(audit.queriedAt).toBe("2026-06-23T00:00:00.000Z");
    expect(audit.dependencyCount).toBe(3);
    expect(audit.vulnerableCount).toBe(2);
    // critical sorts before high
    expect(audit.advisories.map((a) => a.severity)).toEqual(["critical", "high"]);
    expect(audit.advisories.find((a) => a.id === "GHSA-high")).toMatchObject({
      package: "ws",
      version: "8.17.1",
      severity: "high",
      fixedIn: "8.21.0",
      url: "https://example/high",
    });
    // A GHSA-banded record with no CVSS vector carries no numeric score.
    expect(audit.advisories.find((a) => a.id === "GHSA-high")?.cvss).toBeUndefined();
  });

  it("derives severity from a CVSS vector when no GHSA band is published", async () => {
    const fetchImpl = osvStub(
      { results: [{ vulns: [{ id: "CVE-x" }] }, {}, {}] },
      {
        "CVE-x": {
          id: "CVE-x",
          summary: "cvss only",
          severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" }],
        },
      },
    );
    const audit = await auditDependencies("npm/demo@1.0.0", {
      existingLockfile: LOCKFILE_V3,
      fetchImpl,
    });
    expect(audit.status).toBe("ok");
    // CVSS base 7.5 → high band, and the numeric score is surfaced.
    expect(audit.advisories[0]?.severity).toBe("high");
    expect(audit.advisories[0]?.cvss).toBe(7.5);
  });

  it("attaches the CVSS score even when the band comes from the GHSA rating", async () => {
    const fetchImpl = osvStub(
      { results: [{ vulns: [{ id: "GHSA-both" }] }, {}, {}] },
      {
        "GHSA-both": {
          id: "GHSA-both",
          summary: "band + vector",
          database_specific: { severity: "HIGH" },
          severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" }],
        },
      },
    );
    const audit = await auditDependencies("npm/demo@1.0.0", {
      existingLockfile: LOCKFILE_V3,
      fetchImpl,
    });
    expect(audit.advisories[0]?.severity).toBe("high");
    expect(audit.advisories[0]?.cvss).toBe(7.5);
  });

  it("ignores a CVSS v4 vector for scoring (the calculator is v3.x only)", async () => {
    const fetchImpl = osvStub(
      { results: [{ vulns: [{ id: "CVE-v4" }] }, {}, {}] },
      {
        "CVE-v4": {
          id: "CVE-v4",
          summary: "v4 vector",
          severity: [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" }],
        },
      },
    );
    const audit = await auditDependencies("npm/demo@1.0.0", {
      existingLockfile: LOCKFILE_V3,
      fetchImpl,
    });
    expect(audit.advisories[0]?.cvss).toBeUndefined();
    expect(audit.advisories[0]?.severity).toBe("unknown");
  });

  it("returns ok with no advisories when nothing is vulnerable", async () => {
    const fetchImpl = osvStub({ results: [{}, {}, {}] });
    const audit = await auditDependencies("npm/demo@1.0.0", {
      existingLockfile: LOCKFILE_V3,
      fetchImpl,
    });
    expect(audit.status).toBe("ok");
    expect(audit.advisories).toEqual([]);
    expect(audit.vulnerableCount).toBe(0);
    expect(audit.dependencyCount).toBe(3);
  });
});

describe("auditDependencies — graceful degradation", () => {
  it("skips when the vulnerability database is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const audit = await auditDependencies("npm/demo@1.0.0", {
      existingLockfile: LOCKFILE_V3,
      fetchImpl,
    });
    expect(audit.status).toBe("skipped");
    expect(audit.reason).toMatch(/unreachable|offline/i);
  });

  it("skips when the dependency tree cannot be resolved", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const audit = await auditDependencies("npm/demo@1.0.0", {
      resolveLockfile: async () => null,
      fetchImpl,
    });
    expect(audit.status).toBe("skipped");
    expect(audit.reason).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("degrades a single unenrichable advisory to unknown rather than skipping the audit", async () => {
    const fetchImpl = osvStub({ results: [{ vulns: [{ id: "GHSA-missing" }] }, {}, {}] }, {});
    const audit = await auditDependencies("npm/demo@1.0.0", {
      existingLockfile: LOCKFILE_V3,
      fetchImpl,
    });
    expect(audit.status).toBe("ok");
    expect(audit.advisories).toHaveLength(1);
    expect(audit.advisories[0]?.severity).toBe("unknown");
  });
});
