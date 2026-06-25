/**
 * Discover gradeable MCP targets from a repo's MCP config files, and map a
 * server's launch command to a polygraph registry ref. The mapping is
 * deliberately lossy: an entry whose command can't be mapped to a registry ref
 * (a bare binary, a local script) yields ref=null and is surfaced as
 * "could not be graded", never silently dropped.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface DiscoveredTarget {
  /** A gradeable ref (npm/…, pypi/…, or an https URL), or null if unmappable. */
  ref: string | null;
  /** The server's key in the config's server map. */
  name: string;
  /** The config file it came from (relative to cwd). */
  source: string;
  /** The original command line or url, for the "couldn't map" note. */
  raw: string;
}

export const DEFAULT_CONFIG_FILES: readonly string[] = [".mcp.json", ".vscode/mcp.json", ".cursor/mcp.json"];

const NPM_COMMANDS = new Set(["npx", "npm"]);
const PYPI_COMMANDS = new Set(["uvx", "uv", "pipx"]);
// "exec"/"run"/"tool" are package-manager subcommands (npm exec, uv tool run,
// pipx run); "-y"/"--yes" are npx auto-confirm flags. None is a package name.
const SKIP_ARGS = new Set(["exec", "run", "tool", "-y", "--yes"]);

/** Drop a trailing `@version`, preserving a leading scope `@`. */
export function stripNpmVersion(pkg: string): string {
  const at = pkg.lastIndexOf("@");
  return at > 0 ? pkg.slice(0, at) : pkg;
}

/** First positional arg that is a package spec (skip subcommands and flags). */
function firstPackageArg(args: readonly string[]): string | null {
  for (const a of args) {
    if (a.startsWith("-") || SKIP_ARGS.has(a)) continue;
    return a;
  }
  return null;
}

export function refFromCommand(command: string, args: readonly string[]): string | null {
  const cmd = path.basename(command);
  const pkg = firstPackageArg(args);
  if (!pkg) return null;
  if (NPM_COMMANDS.has(cmd)) return `npm/${stripNpmVersion(pkg)}`;
  if (PYPI_COMMANDS.has(cmd)) return `pypi/${stripNpmVersion(pkg)}`;
  return null;
}

interface ServerEntry {
  command?: string;
  args?: string[];
  url?: string;
}

function entriesFrom(parsed: unknown): Record<string, ServerEntry> {
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  const map = (obj.mcpServers ?? obj.servers) as Record<string, ServerEntry> | undefined;
  return map && typeof map === "object" ? map : {};
}

export function discoverTargets(cwd: string, files: readonly string[] = DEFAULT_CONFIG_FILES): DiscoveredTarget[] {
  const out: DiscoveredTarget[] = [];
  for (const rel of files) {
    const abs = path.join(cwd, rel);
    if (!existsSync(abs)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(abs, "utf8"));
    } catch {
      continue; // malformed config — skip, never throw
    }
    for (const [name, entry] of Object.entries(entriesFrom(parsed))) {
      if (entry.url) {
        // Only an http(s) URL is a gradeable remote target; anything else
        // (file:, javascript:, …) is surfaced as unmappable (ref: null), not graded.
        const ref = /^https?:\/\//i.test(entry.url) ? entry.url : null;
        out.push({ ref, name, source: rel, raw: entry.url });
      } else if (entry.command) {
        const raw = [entry.command, ...(entry.args ?? [])].join(" ");
        out.push({ ref: refFromCommand(entry.command, entry.args ?? []), name, source: rel, raw });
      }
    }
  }
  return out;
}
