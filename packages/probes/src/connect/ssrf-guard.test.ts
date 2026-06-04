import { describe, it, expect, afterEach } from "vitest";
import { isPrivateAddress, assertPublicHttpUrl, UnsafeTargetUrlError } from "./ssrf-guard.js";

afterEach(() => {
  delete process.env.POLYGRAPH_ALLOW_PRIVATE_TARGETS;
});

describe("isPrivateAddress", () => {
  it("flags private / loopback / link-local / reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("flags loopback / ULA / link-local / mapped IPv6", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "ff02::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
});

describe("assertPublicHttpUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toBeInstanceOf(UnsafeTargetUrlError);
    await expect(assertPublicHttpUrl("ftp://example.com")).rejects.toBeInstanceOf(UnsafeTargetUrlError);
  });

  it("rejects IP-literal targets in private ranges (metadata, loopback)", async () => {
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      UnsafeTargetUrlError,
    );
    await expect(assertPublicHttpUrl("https://127.0.0.1:8443/mcp")).rejects.toBeInstanceOf(UnsafeTargetUrlError);
    await expect(assertPublicHttpUrl("http://[::1]/mcp")).rejects.toBeInstanceOf(UnsafeTargetUrlError);
  });

  it("rejects plaintext http to a public host", async () => {
    await expect(assertPublicHttpUrl("http://1.1.1.1/mcp")).rejects.toThrow(/plaintext http/);
  });

  it("allows a public https IP literal", async () => {
    await expect(assertPublicHttpUrl("https://1.1.1.1/mcp")).resolves.toBeUndefined();
  });

  it("honors the explicit dev opt-in for loopback", async () => {
    process.env.POLYGRAPH_ALLOW_PRIVATE_TARGETS = "1";
    await expect(assertPublicHttpUrl("http://127.0.0.1:3000/mcp")).resolves.toBeUndefined();
  });
});
