/**
 * Pick which of a package's bins to launch as the MCP server.
 *
 * A package may ship several bins (e.g. a CLI plus a `*-mcp` server) or a default
 * bin that isn't an MCP server at all. The launcher probes candidates IN ORDER
 * and keeps the first that completes an MCP handshake, so it only launches more
 * than one of the package's executables when the likely one fails. Ordering:
 *   1. bins whose name looks like an MCP server (`/mcp/i`)
 *   2. the bin matching the package name (npx's default pick)
 *   3. everything else
 * Order within each group is preserved; duplicates are dropped.
 */

const MCP_NAME = /mcp/i;

export function orderBinCandidates(binNames: readonly string[], pkgName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const take = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };
  for (const n of binNames) if (MCP_NAME.test(n)) take(n);
  for (const n of binNames) if (n === pkgName) take(n);
  for (const n of binNames) take(n);
  return out;
}

/** Parse `npm view <spec> bin --json` output into bin names. A string `bin`
 *  means a single bin keyed by the package name; an object maps name→path; an
 *  empty/absent `bin` yields no candidates. Never throws — returns [] on junk. */
export function parseNpmBins(stdout: string, pkgName: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let v: unknown;
  try {
    v = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof v === "string") return [pkgName];
  if (v && typeof v === "object" && !Array.isArray(v)) return Object.keys(v as Record<string, unknown>);
  return [];
}

export class NoMcpBinError extends Error {
  constructor(ref: string, tried: readonly string[]) {
    super(
      `${ref}: no bin spoke MCP — tried ${tried.length ? tried.join(", ") : "no launchable bins"}. ` +
        `The target must be an MCP server; a CLI-only package can't be graded.`,
    );
    this.name = "NoMcpBinError";
  }
}

/**
 * Try each candidate in order via `attempt`; return the first that resolves to a
 * non-null result (the live connection). `attempt` must return null (not throw)
 * when a candidate isn't an MCP server. Throws NoMcpBinError when none qualify.
 */
export async function probeForMcpBin<T>(
  ref: string,
  candidates: readonly string[],
  attempt: (bin: string) => Promise<T | null>,
): Promise<{ bin: string; result: T }> {
  for (const bin of candidates) {
    const result = await attempt(bin);
    if (result !== null) return { bin, result };
  }
  throw new NoMcpBinError(ref, candidates);
}
