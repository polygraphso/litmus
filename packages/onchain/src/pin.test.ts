import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pinEvidence, PIN_TIMEOUT_MS } from "./pin.js";
import type { EvidenceBundle } from "@polygraph/core";

const bundle: EvidenceBundle = {
  schemaVersion: "1.0.0",
  methodologyVersion: "litmus-v1",
  serverRef: "npm/@scope/server",
  resolvedVersion: "1.2.3",
  target: { kind: "stdio", command: "npx -y @scope/server", url: null },
  toolDefsFingerprint: "0x" + "ab".repeat(32),
  toolDefs: [],
  ranAt: "2026-06-03T15:04:05Z",
  harness: { package: "@polygraph/probes", version: "0.0.0", node: "v22", dockerAvailable: false },
  categories: [
    { code: "C-01", status: "pass", probes: [] },
    { code: "C-02", status: "skipped", probes: [] },
    { code: "C-03", status: "pass", probes: [] },
  ],
  grade: "B",
  gradeRationale: "Injection checks passed; egress not verified.",
  disclaimer: "Self-run, self-minted under litmus-v1.",
};

describe("pinEvidence", () => {
  beforeEach(() => {
    // Start each test with no pinning backend configured; tests opt in.
    vi.stubEnv("PINATA_JWT", "");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("pins to Pinata when PINATA_JWT is set (200 ⇒ via pinata + gateway)", async () => {
    vi.stubEnv("PINATA_JWT", "jwt-token");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ IpfsHash: "H" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await pinEvidence(bundle);
    expect(res).toEqual({
      cid: "ipfs://H",
      via: "pinata",
      gateway: "https://gateway.pinata.cloud/ipfs/H",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.pinata.cloud/pinning/pinJSONToIPFS");
    expect(init?.method).toBe("POST");
    // Body byte-identical to today's request (CID continuity).
    expect(init?.body).toBe(
      JSON.stringify({ pinataContent: bundle, pinataMetadata: { name: "litmus-bundle" } }),
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls through to Supabase when Pinata returns non-ok (500 ⇒ Supabase 201 ⇒ report:<id>)", async () => {
    vi.stubEnv("PINATA_JWT", "jwt-token");
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "abc-123" }]), { status: 201 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await pinEvidence(bundle);
    expect(res).toEqual({ cid: "report:abc-123", via: "supabase" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [pinUrl] = fetchMock.mock.calls[0]!;
    expect(pinUrl).toBe("https://api.pinata.cloud/pinning/pinJSONToIPFS");
    const [supaUrl, supaInit] = fetchMock.mock.calls[1]!;
    expect(supaUrl).toBe("https://proj.supabase.co/rest/v1/litmus_bundles");
    expect(supaInit?.body).toBe(JSON.stringify({ bundle }));
    expect(supaInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws when neither backend is configured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(pinEvidence(bundle)).rejects.toThrow(/no pinning backend available/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a 30s abort timeout constant", () => {
    expect(PIN_TIMEOUT_MS).toBe(30_000);
  });
});
