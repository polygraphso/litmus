/**
 * SSRF guard for remote (`https://`) MCP targets.
 *
 * The harness connects to attacker-supplied URLs. Without a guard it can be
 * pointed at cloud metadata (`169.254.169.254`), loopback, or internal services
 * — server-side request forgery with the runner's network position. Before
 * opening a transport we resolve the host and refuse any address in a private,
 * loopback, link-local, or otherwise-reserved range.
 *
 * Residual (documented, not closed here): a hostname that passes this check but
 * later rebinds, or an allowed host that 30x-redirects to an internal address,
 * is a TOCTOU gap. Production targets must be public; set
 * `POLYGRAPH_ALLOW_PRIVATE_TARGETS=1` only for local development against a
 * loopback server.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeTargetUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTargetUrlError";
  }
}

function allowPrivate(): boolean {
  return process.env.POLYGRAPH_ALLOW_PRIVATE_TARGETS === "1";
}

/** Parse a dotted-quad into 4 octets, or null if it isn't IPv4. */
function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/** True for any IPv4 address an external MCP server must never resolve to. */
function isPrivateIPv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && o[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/** True for any IPv6 address an external MCP server must never resolve to. */
function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]!; // drop any zone id
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — classify the embedded v4.
  const mapped = addr.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped && isPrivateIPv4(mapped[1]!)) return true;
  if (addr.startsWith("fe8") || addr.startsWith("fe9") || addr.startsWith("fea") || addr.startsWith("feb"))
    return true; // fe80::/10 link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7 unique-local
  if (addr.startsWith("ff")) return true; // ff00::/8 multicast
  if (addr.startsWith("2001:db8")) return true; // documentation
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Validate a remote MCP URL before connecting. Throws `UnsafeTargetUrlError`
 * for a non-http(s) scheme, plaintext http to a non-loopback host, or a host
 * that resolves to a private/reserved address.
 */
export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTargetUrlError(`invalid target URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeTargetUrlError(`unsupported scheme "${url.protocol}" — only http(s) MCP targets are allowed`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Resolve to the concrete address(es) we'd actually dial.
  const addresses: string[] = [];
  if (isIP(host)) {
    addresses.push(host);
  } else {
    try {
      const records = await lookup(host, { all: true });
      addresses.push(...records.map((r) => r.address));
    } catch {
      throw new UnsafeTargetUrlError(`could not resolve target host: ${host}`);
    }
  }
  if (addresses.length === 0) {
    throw new UnsafeTargetUrlError(`target host did not resolve: ${host}`);
  }

  const privateHit = addresses.find((a) => isPrivateAddress(a));
  if (privateHit && !allowPrivate()) {
    throw new UnsafeTargetUrlError(
      `target ${host} resolves to a private/reserved address (${privateHit}); refusing (set POLYGRAPH_ALLOW_PRIVATE_TARGETS=1 for local dev)`,
    );
  }

  // Plaintext http is only acceptable to a loopback dev server; over the network
  // it is trivially MITM'd into the same SSRF/poisoning it's meant to prevent.
  if (url.protocol === "http:" && !addresses.every((a) => isPrivateAddress(a)) && !allowPrivate()) {
    throw new UnsafeTargetUrlError(`plaintext http to a public host is not allowed: ${host} (use https)`);
  }
}
