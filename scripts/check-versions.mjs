#!/usr/bin/env node
// Fails when packages/litmus/package.json's version drifts from server.json's
// two version fields, or from the @polygraphso/litmus pin in the Claude Code
// plugin's bundled MCP config (plugins/polygraph/.mcp.json). That pin is
// deliberate: an unpinned `npx -p @polygraphso/litmus` silently reuses
// whatever old build the npx cache holds, so the plugin spawns an exact
// version instead. This check only keeps the three in sync; it does not
// question why the pin exists.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relPath) {
  return JSON.parse(readFileSync(join(rootDir, relPath), "utf8"));
}

const pkg = readJson("packages/litmus/package.json");
const server = readJson("server.json");
const mcpConfig = readJson("plugins/polygraph/.mcp.json");

const pkgVersion = pkg.version;
const pinPrefix = "@polygraphso/litmus@";
const pinArgs = mcpConfig.mcpServers?.["polygraph-litmus"]?.args ?? [];
const pinArg = pinArgs.find((a) => typeof a === "string" && a.startsWith(pinPrefix));
const pinnedVersion = pinArg ? pinArg.slice(pinPrefix.length) : undefined;

const checks = [
  ["server.json version", server.version],
  ["server.json packages[0].version", server.packages?.[0]?.version],
  ["plugins/polygraph/.mcp.json npx pin", pinnedVersion],
];

const mismatches = checks.filter(([, value]) => value !== pkgVersion);

if (mismatches.length > 0) {
  console.error(`packages/litmus/package.json is at ${pkgVersion}, but:`);
  for (const [label, value] of mismatches) {
    console.error(`  ${label} is ${value ?? "(not found)"}`);
  }
  console.error("Bump the drifted value(s) to match, or bump the package version if that was the intent.");
  process.exit(1);
}

console.log(`Version pins in sync at ${pkgVersion} (package.json, server.json x2, plugin pin).`);
