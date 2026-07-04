// Minimal MCP stdio smoke test for the staged MCPB entry point: spawn the
// server, run initialize + tools/list over JSON-RPC, and require the expected
// tool surface. Exits non-zero on any miss so the release job fails loudly
// rather than attaching a broken bundle.
import { spawn } from "node:child_process";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node smoke-test.mjs <path-to-mcp-entry>");
  process.exit(2);
}

const EXPECTED = ["check_server", "list_servers", "request_grade", "run_litmus"];
const child = spawn("node", [entry], { stdio: ["pipe", "pipe", "inherit"] });

const msgs = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpb-smoke", version: "0.0.1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
];
child.stdin.write(msgs.map((m) => JSON.stringify(m) + "\n").join(""));

let buf = "";
const timeout = setTimeout(() => {
  console.error("smoke test timed out (30s)");
  child.kill();
  process.exit(1);
}, 30_000);

child.stdout.on("data", (chunk) => {
  buf += chunk;
  for (const line of buf.split("\n")) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 2 && msg.result?.tools) {
      const names = msg.result.tools.map((t) => t.name);
      const missing = EXPECTED.filter((n) => !names.includes(n));
      clearTimeout(timeout);
      child.kill();
      if (missing.length) {
        console.error(`missing expected tools: ${missing.join(", ")} (got: ${names.join(", ")})`);
        process.exit(1);
      }
      console.log(`smoke test ok: ${names.length} tools (${names.join(", ")})`);
      process.exit(0);
    }
  }
});
