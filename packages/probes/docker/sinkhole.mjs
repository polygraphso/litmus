#!/usr/bin/env node
/**
 * Egress sinkhole. Runs inside the egress-sniff container on an `--internal`
 * Docker network. DNS answers every query with the sink's own IP, so the target
 * dials back to us; the entrypoint's iptables REDIRECT funnels all inbound TCP
 * (any port) to our listener, where we log `{host, port, firstBytes}` and drop
 * the connection — never completing it. One `EGRESS {json}` line per attempt.
 *
 * KNOWN LIMIT (documented, v1): capture is DNS-ROUTED. A target that connects to
 * a hard-coded IP literal — or uses DoH/DoT to a hard-coded resolver IP — issues
 * no sinkholed lookup, so its packet is dropped by the `--internal` network and
 * never reaches this listener: C-02 then reads as a false "no egress" pass. The
 * real data still never leaves the box. Closing it needs DNS-independent capture
 * (sink as default gateway + DNAT all egress) — roadmap. See
 * docs/litmus-test-v1.md §7.
 */

import dgram from "node:dgram";
import net from "node:net";

const TCP_SINK_PORT = 8443;
const emit = (rec) => process.stdout.write("EGRESS " + JSON.stringify(rec) + "\n");

function ipBytes() {
  const parts = (process.env.SINK_IP || "203.0.113.1").trim().split(".").map((n) => parseInt(n, 10) & 0xff);
  return parts.length === 4 && parts.every((n) => Number.isFinite(n)) ? parts : [203, 0, 113, 1];
}

// ── DNS (UDP 53): log the queried name, answer A with the sink's IP. ──────────
const udp = dgram.createSocket("udp4");
udp.on("message", (msg, rinfo) => {
  try {
    const name = decodeQName(msg, 12);
    if (name) emit({ kind: "dns", host: name });
    udp.send(dnsAnswer(msg), rinfo.port, rinfo.address);
  } catch {
    /* ignore malformed query */
  }
});
udp.on("error", () => {});
udp.bind(53);

// ── TCP: all inbound TCP REDIRECTed here; log first bytes + sniffed host. ─────
const srv = net.createServer((sock) => {
  sock.setTimeout(2000, () => sock.destroy());
  sock.once("data", (buf) => {
    emit({ kind: "tcp", host: sniffHost(buf), port: sock.localPort, firstBytes: printable(buf.subarray(0, 64)) });
    sock.destroy();
  });
  sock.on("error", () => {});
});
srv.on("error", () => {});
srv.listen(TCP_SINK_PORT, "0.0.0.0");
process.stdout.write("EGRESS-SINK ready\n");

function printable(b) {
  return b.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
}

function decodeQName(msg, off) {
  const labels = [];
  let i = off;
  while (i < msg.length) {
    const len = msg[i];
    if (len === 0 || (len & 0xc0) === 0xc0) break;
    labels.push(msg.toString("ascii", i + 1, i + 1 + len));
    i += 1 + len;
  }
  return labels.join(".");
}

function dnsAnswer(query) {
  const id = query.subarray(0, 2);
  const question = query.subarray(12); // question section (single-question queries)
  const header = Buffer.from([id[0], id[1], 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const [a, b, c, d] = ipBytes();
  const answer = Buffer.from([0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1e, 0x00, 0x04, a, b, c, d]);
  return Buffer.concat([header, question, answer]);
}

function sniffHost(buf) {
  const s = buf.toString("latin1");
  const http = s.match(/host:\s*([^\r\n]+)/i);
  if (http) return http[1].trim();
  if (buf[0] === 0x16) {
    const sni = s.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}/i); // best-effort SNI
    if (sni) return sni[0];
  }
  return undefined;
}
