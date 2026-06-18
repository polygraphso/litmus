/**
 * Connect to a target MCP server the way an agent would (technical-design §3).
 *
 * - a local package ref (`npm/…`, `pypi/…`) is launched as a subprocess over
 *   **stdio** (`npx -y` / `uvx`);
 * - a remote `https://` URL is reached over **Streamable HTTP**;
 * - an explicit `{command,args}` (for in-repo demo servers and tests) launches
 *   over stdio directly.
 *
 * For an npm ref the package may ship several bins (e.g. a CLI plus a `*-mcp`
 * server) or a default bin that isn't an MCP server. We enumerate the bins and
 * PROBE them in order (mcp-named first), keeping the first that completes the MCP
 * handshake — so a CLI-first or multi-bin package still grades.
 *
 * Returns the connected `Client`, a descriptor for the evidence bundle, and a
 * teardown. The normal MCP handshake (`initialize`) happens inside `connect()`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sameOriginAuthFetch } from "./auth-fetch.js";
import {
  parseServerRef,
  serverKey,
  type ParsedServerRef,
  type TargetDescriptor,
  type TargetKind,
} from "@polygraph/core";
import { assertPublicHttpUrl } from "./ssrf-guard.js";
import {
  containerLaunch,
  recordedContainerCommand,
  prepareSeedVolume,
  IsolationUnsupportedError,
  type SeedVolume,
} from "./container.js";
import { docker, ensureImage, stageNpmPackage, type StagedPackage } from "../docker/staging.js";
import { resolveStagedVersion } from "./version.js";
import { orderBinCandidates, parseNpmBins, probeForMcpBin } from "./bin-candidates.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileP = promisify(execFile);

/**
 * How the launched target's stderr is handled. The SDK default is `"inherit"`,
 * which dumps the server's own startup banner onto the operator's terminal — and
 * twice, since bin-probing launches several candidates. Pipe it instead (drained
 * to discard once connected, see {@link discardStderr}) so the run output stays
 * clean. Set `LITMUS_DEBUG` to inherit it again when diagnosing a launch.
 */
const TARGET_STDERR: "inherit" | "pipe" = process.env.LITMUS_DEBUG ? "inherit" : "pipe";

/** Drain a piped child's stderr to discard, so its buffer can't fill and stall
 *  the target mid-run (a blocked write would look like a crash to C-04). */
function discardStderr(transport: StdioClientTransport | StreamableHTTPClientTransport): void {
  (transport as { stderr?: NodeJS.ReadableStream | null }).stderr?.resume?.();
}

export { IsolationUnsupportedError } from "./container.js";
export { NoMcpBinError } from "./bin-candidates.js";

export interface StdioCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Friendly identity for the evidence bundle (defaults to the command line). */
  serverRef?: string;
}

/** A litmus target: a server ref string, an https URL, or an explicit stdio command. */
export type TargetInput = string | StdioCommand;

export interface ConnectedTarget {
  client: Client;
  kind: TargetKind;
  descriptor: TargetDescriptor;
  /** Canonical versionless identity (serverKey), the URL, or the command line. */
  serverRef: string;
  resolvedVersion: string | null;
  /** The server's self-asserted `serverInfo.version` from the MCP handshake.
   *  Descriptive metadata only (see EvidenceBundle.selfReportedVersion). */
  selfReportedVersion: string | null;
  teardown: () => Promise<void>;
}

export interface ConnectOptions {
  /** Env to seed into a locally-launched server (e.g. canaries for C-03). */
  seedEnv?: Record<string, string>;
  /** Working directory to launch a local stdio server in (e.g. a canary-seeded cwd for C-03 4.1). */
  seedCwd?: string;
  /**
   * HTTP request headers for a remote (`https://`) target — e.g.
   * `{ Authorization: "Bearer …" }` to reach an OAuth-gated MCP server. Ignored
   * for stdio targets (those authenticate via env). Sent only to the target
   * origin (see `sameOriginAuthFetch`).
   */
  httpHeaders?: Record<string, string>;
  /**
   * stdio execution mode. "none" (default) launches the target on the host;
   * "docker" runs an npm target ONLY inside the hardened container and
   * throws IsolationUnsupportedError for any other stdio kind. http targets are
   * unaffected (isolation is stdio-only).
   */
  isolation?: "none" | "docker";
  /** Label every docker resource created here, so a killed parent can sweep. */
  runLabel?: string;
}

const CLIENT_INFO = { name: "polygraph-litmus", version: "0.0.0" };

export async function connectTarget(
  input: TargetInput,
  opts: ConnectOptions = {},
): Promise<ConnectedTarget> {
  const isolated = opts.isolation === "docker";

  // ── explicit stdio command (in-repo demos / tests) ──
  if (typeof input !== "string") {
    // An explicit stdio command can't be sandboxed (we don't know its registry
    // identity, and the egress runner already wraps `docker run` itself). Fail
    // closed rather than silently executing it on the host under isolation.
    if (isolated) {
      throw new IsolationUnsupportedError(
        "docker isolation is unsupported for an explicit stdio command — only an npm ref can be containerized",
      );
    }
    const transport = new StdioClientTransport({
      command: input.command,
      args: input.args ?? [],
      env: { ...getDefaultEnvironment(), ...(opts.seedEnv ?? {}), ...(input.env ?? {}) },
      stderr: TARGET_STDERR,
      ...(input.cwd ?? opts.seedCwd ? { cwd: input.cwd ?? opts.seedCwd } : {}),
    });
    const cmdline = [input.command, ...(input.args ?? [])].join(" ");
    const client = await connectOrThrow(transport);
    return makeResult(client, "stdio", { kind: "stdio", command: cmdline, url: null }, input.serverRef ?? cmdline, null, []);
  }

  // ── remote https URL ──
  if (/^https?:\/\//i.test(input)) {
    // Isolation is stdio-only; an https target is graded IN-PROCESS (no
    // container). The hosted service does accept https targets — it does NOT
    // reject them — so the in-process run is bounded by RunLitmusOptions.timeoutMs
    // and the SSRF guard below refuses private/reserved addresses before connecting.
    await assertPublicHttpUrl(input);
    const headers =
      opts.httpHeaders && Object.keys(opts.httpHeaders).length > 0 ? opts.httpHeaders : undefined;
    const transport = new StreamableHTTPClientTransport(
      new URL(input),
      headers ? { requestInit: { headers }, fetch: sameOriginAuthFetch(input, headers) } : undefined,
    );
    const client = await connectOrThrow(transport);
    return makeResult(client, "http", { kind: "http", command: null, url: input }, input, null, []);
  }

  // ── registry ref (npm / pypi / github) ──
  const parsed = parseServerRef(input);

  if (isolated) {
    if (parsed.registry !== "npm") {
      throw new IsolationUnsupportedError(
        `docker isolation is unsupported for ${parsed.registry} refs — only npm refs can be containerized`,
      );
    }
    return connectIsolatedNpm(input, parsed, opts);
  }
  if (parsed.registry === "npm") {
    return connectHostNpm(input, parsed, opts);
  }
  // pypi (uvx) / github: single launchable entry, no bin probing. launchForRef
  // throws for github (not launchable over stdio).
  const launch = launchForRef(parsed);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: { ...getDefaultEnvironment(), ...(opts.seedEnv ?? {}) },
    stderr: TARGET_STDERR,
    ...(opts.seedCwd ? { cwd: opts.seedCwd } : {}),
  });
  const client = await connectOrThrow(transport);
  return makeResult(
    client,
    "stdio",
    { kind: "stdio", command: [launch.command, ...launch.args].join(" "), url: null },
    serverKey(parsed),
    parsed.version ?? null,
    [],
  );
}

/**
 * Host npm path: enumerate the package's bins (registry metadata — no target code
 * runs), then probe them in order (mcp-named first) via `npx -p`, keeping the
 * first that speaks MCP. When the bins can't be enumerated (offline / npm view
 * fails / no bin), fall back to the plain `npx -y <spec>` single launch.
 */
async function connectHostNpm(
  ref: string,
  parsed: ParsedServerRef,
  opts: ConnectOptions,
): Promise<ConnectedTarget> {
  const spec = (parsed.owner ? `${parsed.owner}/${parsed.name}` : parsed.name) + (parsed.version ? `@${parsed.version}` : "");
  const serverRefVal = serverKey(parsed);
  const resolvedVersion = parsed.version ?? null;
  const env = { ...getDefaultEnvironment(), ...(opts.seedEnv ?? {}) };
  const cwd = opts.seedCwd ? { cwd: opts.seedCwd } : {};

  const binNames = await fetchNpmBins(spec, parsed.name);
  if (!binNames || binNames.length === 0) {
    // Couldn't enumerate — preserve the original single-launch behavior.
    const args = ["-y", spec];
    const transport = new StdioClientTransport({ command: "npx", args, env, stderr: TARGET_STDERR, ...cwd });
    const client = await connectOrThrow(transport);
    return makeResult(client, "stdio", { kind: "stdio", command: ["npx", ...args].join(" "), url: null }, serverRefVal, resolvedVersion, []);
  }

  const candidates = orderBinCandidates(binNames, parsed.name);
  const { result } = await probeForMcpBin(ref, candidates, async (bin) => {
    const args = ["-y", "-p", spec, bin];
    const transport = new StdioClientTransport({ command: "npx", args, env, stderr: TARGET_STDERR, ...cwd });
    const client = await tryConnect(transport);
    return client ? { client, descriptor: { kind: "stdio", command: ["npx", ...args].join(" "), url: null } as TargetDescriptor } : null;
  });
  return makeResult(result.client, "stdio", result.descriptor, serverRefVal, resolvedVersion, []);
}

/**
 * Containerized npm path. Stage the install once (network on, --ignore-scripts,
 * no target code runs), seed canaries, then probe the package's bins IN the
 * hardened container — mcp-named first, first MCP handshake wins. Each probe is
 * egress-sandboxed; losing containers are removed as we go.
 */
async function connectIsolatedNpm(
  ref: string,
  parsed: ParsedServerRef,
  opts: ConnectOptions,
): Promise<ConnectedTarget> {
  const spec = (parsed.owner ? `${parsed.owner}/${parsed.name}` : parsed.name) + (parsed.version ? `@${parsed.version}` : "");
  const stageOpts = opts.runLabel ? { runLabel: opts.runLabel } : {};

  await ensureImage();
  let staged: StagedPackage | null = null;
  let seed: SeedVolume | null = null;
  try {
    staged = await stageNpmPackage(spec, stageOpts);
    if (!opts.seedCwd) {
      throw new Error("docker isolation requires a canary seed directory (seedCwd)");
    }
    seed = await prepareSeedVolume(opts.seedCwd, stageOpts);
    // Record the version the offline resolver actually read from the installed
    // package.json — never the requested pin, which is unverified until install.
    const resolvedVersion = resolveStagedVersion(parsed.version, staged.resolvedVersion);
    const stagedPkg = staged;
    const seedVol = seed;

    const candidates = orderBinCandidates(Object.keys(stagedPkg.bins), parsed.name);
    const { result } = await probeForMcpBin(ref, candidates, async (binName) => {
      const launch = containerLaunch({
        entry: stagedPkg.bins[binName]!,
        stageVolume: stagedPkg.volume,
        seedVolume: seedVol.volume,
        // Canaries travel INTO the container via -e, NOT via the docker CLI's own env.
        canaryEnv: opts.seedEnv ?? {},
        ...(opts.runLabel ? { runLabel: opts.runLabel } : {}),
        ...(process.env.LITMUS_DOCKER_RUNTIME ? { runtime: process.env.LITMUS_DOCKER_RUNTIME } : {}),
      });
      // Name the container so we can force-remove it (a `node` server over
      // `docker run -i` doesn't exit on stdin close, so `--rm` never fires).
      const containerName = `pg-connect-${randomUUID().slice(0, 8)}`;
      const namedArgs = [launch.args[0]!, "--name", containerName, ...launch.args.slice(1)];
      const transport = new StdioClientTransport({
        command: launch.command,
        args: namedArgs,
        env: getDefaultEnvironment(), // default env only: no host secrets, no canaries
        stderr: TARGET_STDERR,
      });
      const client = await tryConnect(transport);
      if (!client) {
        await docker(["rm", "-f", containerName]).then(() => {}).catch(() => {});
        return null;
      }
      // Stable, secret-free recorded command (no --name, no canary -e, volumes placeheld).
      const descriptor: TargetDescriptor = {
        kind: "stdio",
        command: recordedContainerCommand(launch.command, launch.args, {
          stageVolume: stagedPkg.volume,
          seedVolume: seedVol.volume,
        }),
        url: null,
      };
      return { client, descriptor, containerName };
    });

    // Order matters at teardown: force-remove the container FIRST, then volumes.
    const teardownExtra: Array<() => Promise<void>> = [
      () => docker(["rm", "-f", result.containerName]).then(() => {}).catch(() => {}),
      staged.cleanup,
      seed.cleanup,
    ];
    return makeResult(result.client, "stdio", result.descriptor, serverKey(parsed), resolvedVersion, teardownExtra);
  } catch (err) {
    // Roll back any volumes created before the failure (incl. NoMcpBinError), then
    // rethrow — fail closed.
    if (seed) await seed.cleanup();
    if (staged) await staged.cleanup();
    throw err;
  }
}

/** Enumerate an npm package's bin names from registry metadata. No target code
 *  runs — `npm view … bin` reads the manifest. Returns null when the lookup
 *  fails (offline / not found) so the caller can fall back. */
async function fetchNpmBins(spec: string, pkgName: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP("npm", ["view", spec, "bin", "--json"], { timeout: 20_000 });
    return parseNpmBins(stdout, pkgName);
  } catch {
    return null;
  }
}

/** Build the connected `Client` and attempt the bounded MCP handshake. Returns
 *  null (transport already closed) when the target isn't a live MCP server, so
 *  the bin-probe loop can try the next candidate. */
async function tryConnect(
  transport: StdioClientTransport | StreamableHTTPClientTransport,
): Promise<Client | null> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await withConnectTimeout(client.connect(transport), transport);
    discardStderr(transport);
    return client;
  } catch {
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
    return null;
  }
}

/** Connect once, throwing on failure (for non-probed targets: explicit command,
 *  http, pypi/github). withConnectTimeout closes the transport on failure. */
async function connectOrThrow(
  transport: StdioClientTransport | StreamableHTTPClientTransport,
): Promise<Client> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await withConnectTimeout(client.connect(transport), transport);
  discardStderr(transport);
  return client;
}

function makeResult(
  client: Client,
  kind: TargetKind,
  descriptor: TargetDescriptor,
  serverRef: string,
  resolvedVersion: string | null,
  teardownExtra: Array<() => Promise<void>>,
): ConnectedTarget {
  return {
    client,
    kind,
    descriptor,
    serverRef,
    resolvedVersion,
    // The server's self-reported identity from the initialize handshake. The SDK
    // exposes it post-connect via getServerVersion(); absent/blank → null.
    selfReportedVersion: client.getServerVersion()?.version ?? null,
    teardown: async () => {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
      // Remove the container path's volumes AFTER the client (and its
      // `docker run -i` stdio CLI) have been torn down.
      for (const c of teardownExtra) await c();
    },
  };
}

/** Hard cap on the MCP `initialize` handshake. */
const CONNECT_TIMEOUT_MS = 30_000;

async function withConnectTimeout(
  connecting: Promise<void>,
  transport: StdioClientTransport | StreamableHTTPClientTransport,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("MCP connect/initialize timed out")), CONNECT_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([connecting, timeout]);
  } catch (err) {
    // Tear down the half-open transport so the spawned process / socket is freed.
    await transport.close().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// npm refs are launched by connectHostNpm (with bin probing); this only handles
// the other launchable stdio registry (pypi → uvx) and rejects the rest.
function launchForRef(p: ParsedServerRef): { command: string; args: string[] } {
  if (p.registry === "pypi") {
    return { command: "uvx", args: [p.version ? `${p.name}@${p.version}` : p.name] };
  }
  throw new Error(
    `registry "${p.registry}" is not launchable over stdio (only npm/pypi). Use an https:// URL for a remote MCP server.`,
  );
}
