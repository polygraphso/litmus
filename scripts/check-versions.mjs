#!/usr/bin/env node
// Fails when packages/litmus/package.json's version drifts from server.json's
// two version fields, the @polygraphso/litmus pin in the Claude Code plugin's
// bundled MCP config (plugins/polygraph/.mcp.json), or the @polygraphso/litmus
// pin in action.yml's `version` input default. Those pins are deliberate: an
// unpinned `npx -p @polygraphso/litmus` silently reuses whatever old build the
// npx cache holds, so the plugin and the CI action spawn an exact version
// instead. This check only keeps them in sync; it does not question why the
// pins exist.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relPath) {
  return JSON.parse(readFileSync(join(rootDir, relPath), "utf8"));
}

// action.yml is YAML, not JSON, so read the `version` input's `default:`
// value with a small line scan instead of pulling in a YAML parser for one
// field. Inputs are 2-space indented keys; each input's properties (and any
// comment lines above them) are 4-space indented, so a line back at 2-space
// indent marks the start of the next sibling input.
function readActionVersionPin(relPath) {
  const lines = readFileSync(join(rootDir, relPath), "utf8").split("\n");
  const start = lines.findIndex((line) => /^\s{2}version:\s*$/.test(line));
  if (start === -1) return undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{2}\S/.test(line)) break; // next sibling input key
    const match = line.match(/^\s{4}default:\s*"([^"]*)"/);
    if (match) return match[1];
  }
  return undefined;
}

const pkg = readJson("packages/litmus/package.json");
const server = readJson("server.json");
const mcpConfig = readJson("plugins/polygraph/.mcp.json");

const pkgVersion = pkg.version;
const pinPrefix = "@polygraphso/litmus@";
const pinArgs = mcpConfig.mcpServers?.["polygraph-litmus"]?.args ?? [];
const pinArg = pinArgs.find((a) => typeof a === "string" && a.startsWith(pinPrefix));
const pinnedVersion = pinArg ? pinArg.slice(pinPrefix.length) : undefined;
const actionVersionPin = readActionVersionPin("action.yml");

const checks = [
  ["server.json version", server.version],
  ["server.json packages[0].version", server.packages?.[0]?.version],
  ["plugins/polygraph/.mcp.json npx pin", pinnedVersion],
  ["action.yml inputs.version default", actionVersionPin],
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

console.log(`Version pins in sync at ${pkgVersion} (package.json, server.json x2, plugin pin, action.yml pin).`);
