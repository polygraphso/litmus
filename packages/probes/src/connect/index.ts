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
  type PresentedClientInfo,
  type TargetDescriptor,
  type TargetKind,
} from "@polygraph/core";
import { assertPublicHttpUrl } from "./ssrf-guard.js";
import { selectClientIdentity } from "./client-identity.js";
import {
  containerLaunch,
  recordedContainerCommand,
  prepareSeedVolume,
  resolveStagedEntry,
  IsolationUnsupportedError,
  type SeedVolume,
} from "./container.js";
import { docker, ensureImage, stageNpmPackage, stagePypiPackage, stageGithubPackage, type StagedPackage } from "../docker/staging.js";
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
  /** The client identity presented in this handshake (litmus-v17). Recorded
   *  in the evidence bundle so a grade discloses what it presented. */
  clientInfo: PresentedClientInfo;
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
  /**
   * Startup env the target needs to boot (e.g. an API key). For a containerized
   * launch it travels via `-e` like the canaries and is redacted from the recorded
   * command; on the host path it rides the child process env (never the recorded
   * command line). Merged after `seedEnv`, so it wins a key collision. Ignored for
   * an https target (those authenticate via headers).
   */
  serverEnv?: Record<string, string>;
  /**
   * Arguments appended to the launched server command (e.g. a subcommand
   * `mcp serve`). Exec args, never shell-split. When set (or `entrySubpath` is),
   * bin enumeration is bypassed: exactly the given launch is attempted, no
   * multi-bin probing. Recorded in the evidence (they describe the launch surface).
   */
  serverArgs?: string[];
  /**
   * A package-relative file to launch instead of a declared bin (e.g.
   * `mcp/server.mjs`), for a server whose entry is neither a `bin` nor `main`.
   * Resolved inside the staged package root and rejected if it escapes. Only
   * supported under docker isolation (it needs the package staged at a known
   * path) for npm/github targets; unsupported on the host path or for pypi.
   */
  entrySubpath?: string;
}

/** The seed `selectClientIdentity` picks against: the target string itself, or
 *  an explicit command's declared ref / command line. Deterministic per target
 *  so re-grading the same server presents the same identity (litmus-v17). */
function identitySeedKey(input: TargetInput): string {
  return typeof input === "string" ? input : (input.serverRef ?? input.command);
}

export async function connectTarget(
  input: TargetInput,
  opts: ConnectOptions = {},
): Promise<ConnectedTarget> {
  const isolated = opts.isolation === "docker";
  const clientInfo = selectClientIdentity(identitySeedKey(input));

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
    if (opts.entrySubpath !== undefined) {
      throw new Error("--entry is not supported for an explicit stdio command or a local entry file (there is no staged package to resolve it against)");
    }
    const args = [...(input.args ?? []), ...(opts.serverArgs ?? [])];
    const transport = new StdioClientTransport({
      command: input.command,
      args,
      // serverEnv sits before input.env so an explicit command's own env still wins.
      env: { ...getDefaultEnvironment(), ...(opts.seedEnv ?? {}), ...(opts.serverEnv ?? {}), ...(input.env ?? {}) },
      stderr: TARGET_STDERR,
      ...(input.cwd ?? opts.seedCwd ? { cwd: input.cwd ?? opts.seedCwd } : {}),
    });
    const cmdline = [input.command, ...args].join(" ");
    const client = await connectOrThrow(transport, clientInfo);
    return makeResult(client, "stdio", { kind: "stdio", command: cmdline, url: null }, input.serverRef ?? cmdline, null, [], clientInfo);
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
    const client = await connectOrThrow(transport, clientInfo);
    return makeResult(client, "http", { kind: "http", command: null, url: input }, input, null, [], clientInfo);
  }

  // ── registry ref (npm / pypi / github) ──
  const parsed = parseServerRef(input);

  if (isolated) {
    if (parsed.registry !== "npm" && parsed.registry !== "pypi" && parsed.registry !== "github") {
      throw new IsolationUnsupportedError(
        `docker isolation is unsupported for ${parsed.registry} refs — only npm, pypi, and github refs can be containerized`,
      );
    }
    return connectIsolated(input, parsed, opts);
  }
  if (parsed.registry === "npm") {
    return connectHostNpm(input, parsed, opts);
  }
  // pypi (uvx) / github: single launchable entry, no bin probing. launchForRef
  // throws for github (not launchable over stdio).
  if (opts.entrySubpath !== undefined) {
    throw new Error("--entry is only supported under docker isolation (it needs the package staged at a known path). Set LITMUS_STDIO_ISOLATION=docker.");
  }
  const launch = launchForRef(parsed);
  const args = [...launch.args, ...(opts.serverArgs ?? [])];
  const transport = new StdioClientTransport({
    command: launch.command,
    args,
    env: { ...getDefaultEnvironment(), ...(opts.seedEnv ?? {}), ...(opts.serverEnv ?? {}) },
    stderr: TARGET_STDERR,
    ...(opts.seedCwd ? { cwd: opts.seedCwd } : {}),
  });
  const client = await connectOrThrow(transport, clientInfo);
  return makeResult(
    client,
    "stdio",
    { kind: "stdio", command: [launch.command, ...args].join(" "), url: null },
    serverKey(parsed),
    parsed.version ?? null,
    [],
    clientInfo,
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
  const clientInfo = selectClientIdentity(ref);
  if (opts.entrySubpath !== undefined) {
    throw new Error("--entry is only supported under docker isolation (it needs the package staged at a known path). Set LITMUS_STDIO_ISOLATION=docker.");
  }
  const env = { ...getDefaultEnvironment(), ...(opts.seedEnv ?? {}), ...(opts.serverEnv ?? {}) };
  const cwd = opts.seedCwd ? { cwd: opts.seedCwd } : {};
  const extraArgs = opts.serverArgs ?? [];

  // Explicit server args → the operator named the launch: run the default bin
  // with those args, a single attempt (no bin probing).
  if (extraArgs.length > 0) {
    const args = ["-y", spec, ...extraArgs];
    const transport = new StdioClientTransport({ command: "npx", args, env, stderr: TARGET_STDERR, ...cwd });
    const client = await connectOrThrow(transport, clientInfo);
    return makeResult(client, "stdio", { kind: "stdio", command: ["npx", ...args].join(" "), url: null }, serverRefVal, resolvedVersion, [], clientInfo);
  }

  const binNames = await fetchNpmBins(spec, parsed.name);
  if (!binNames || binNames.length === 0) {
    // Couldn't enumerate — preserve the original single-launch behavior.
    const args = ["-y", spec];
    const transport = new StdioClientTransport({ command: "npx", args, env, stderr: TARGET_STDERR, ...cwd });
    const client = await connectOrThrow(transport, clientInfo);
    return makeResult(client, "stdio", { kind: "stdio", command: ["npx", ...args].join(" "), url: null }, serverRefVal, resolvedVersion, [], clientInfo);
  }

  const candidates = orderBinCandidates(binNames, parsed.name);
  const { result } = await probeForMcpBin(ref, candidates, async (bin) => {
    const args = ["-y", "-p", spec, bin];
    const transport = new StdioClientTransport({ command: "npx", args, env, stderr: TARGET_STDERR, ...cwd });
    const client = await tryConnect(transport, clientInfo);
    return client ? { client, descriptor: { kind: "stdio", command: ["npx", ...args].join(" "), url: null } as TargetDescriptor } : null;
  });
  return makeResult(result.client, "stdio", result.descriptor, serverRefVal, resolvedVersion, [], clientInfo);
}

/**
 * Containerized npm / pypi path. Stage the install once with no target code run
 * (npm: network on, `--ignore-scripts`; pypi: wheels-only into a venv, no build
 * hooks), seed canaries, then probe the package's bins IN the hardened container —
 * mcp-named first, first MCP handshake wins. A pypi package is launched with its
 * venv python (`staged.interpreter`); npm defaults to `node`. Each probe is
 * egress-sandboxed; losing containers are removed as we go.
 */
async function connectIsolated(
  ref: string,
  parsed: ParsedServerRef,
  opts: ConnectOptions,
): Promise<ConnectedTarget> {
  const stageOpts = opts.runLabel ? { runLabel: opts.runLabel } : {};
  const clientInfo = selectClientIdentity(ref);

  await ensureImage();
  let staged: StagedPackage | null = null;
  let seed: SeedVolume | null = null;
  try {
    staged =
      parsed.registry === "pypi"
        ? await stagePypiPackage(parsed.name, parsed.version, stageOpts)
        : parsed.registry === "github"
          ? await stageGithubPackage(parsed.owner ?? "", parsed.name, parsed.version, stageOpts)
          : await stageNpmPackage(
              (parsed.owner ? `${parsed.owner}/${parsed.name}` : parsed.name) + (parsed.version ? `@${parsed.version}` : ""),
              stageOpts,
            );
    if (!opts.seedCwd) {
      throw new Error("docker isolation requires a canary seed directory (seedCwd)");
    }
    seed = await prepareSeedVolume(opts.seedCwd, stageOpts);
    // Record the version the offline resolver actually read from the installed
    // package.json — never the requested pin, which is unverified until install.
    // github pins the resolved commit SHA directly; the npm concrete-version guard
    // (a semver mismatch) doesn't apply to a git ref.
    const resolvedVersion =
      parsed.registry === "github"
        ? staged.resolvedVersion
        : resolveStagedVersion(parsed.version, staged.resolvedVersion);
    const stagedPkg = staged;
    const seedVol = seed;

    // One launch attempt for a given entry path. Returns the connected client +
    // recorded descriptor, or null if the target didn't complete the handshake.
    const launchOne = async (
      entry: string,
    ): Promise<{ client: Client; descriptor: TargetDescriptor; containerName: string } | null> => {
      const launch = containerLaunch({
        entry,
        stageVolume: stagedPkg.volume,
        seedVolume: seedVol.volume,
        // Canaries travel INTO the container via -e, NOT via the docker CLI's own env.
        canaryEnv: opts.seedEnv ?? {},
        // Operator startup env rides the same -e channel (redacted from the record).
        ...(opts.serverEnv ? { serverEnv: opts.serverEnv } : {}),
        ...(opts.serverArgs && opts.serverArgs.length > 0 ? { serverArgs: opts.serverArgs } : {}),
        ...(opts.runLabel ? { runLabel: opts.runLabel } : {}),
        ...(process.env.LITMUS_DOCKER_RUNTIME ? { runtime: process.env.LITMUS_DOCKER_RUNTIME } : {}),
        // pypi launches with its venv python; npm defaults to node.
        ...(stagedPkg.interpreter ? { interpreter: stagedPkg.interpreter } : {}),
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
      const client = await tryConnect(transport, clientInfo);
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
    };

    // When the operator names the launch precisely (an --entry subpath, or explicit
    // server args), attempt exactly that ONE launch — no bin probing. Otherwise probe
    // the package's bins (mcp-named first) and keep the first that handshakes.
    const explicit = opts.entrySubpath !== undefined || (opts.serverArgs?.length ?? 0) > 0;
    let result: { client: Client; descriptor: TargetDescriptor; containerName: string };
    if (explicit) {
      let entry: string;
      if (opts.entrySubpath !== undefined) {
        if (!stagedPkg.root) {
          throw new Error(`--entry is not supported for ${parsed.registry} targets (no resolvable package root)`);
        }
        entry = resolveStagedEntry(stagedPkg.root, opts.entrySubpath);
      } else {
        // serverArgs without an --entry: launch the primary bin (mcp-named first) with them.
        const candidates = orderBinCandidates(Object.keys(stagedPkg.bins), parsed.name);
        if (!candidates[0]) {
          throw new Error("no launchable bin found for this package; pass --entry <subpath> to name the server entry file");
        }
        entry = stagedPkg.bins[candidates[0]]!;
      }
      const single = await launchOne(entry);
      if (!single) {
        const how = opts.entrySubpath !== undefined ? `entry ${JSON.stringify(opts.entrySubpath)}` : "the given server args";
        throw new Error(`the target did not complete the MCP handshake with ${how}`);
      }
      result = single;
    } else {
      const candidates = orderBinCandidates(Object.keys(stagedPkg.bins), parsed.name);
      ({ result } = await probeForMcpBin(ref, candidates, async (binName) => launchOne(stagedPkg.bins[binName]!)));
    }

    // Order matters at teardown: force-remove the container FIRST, then volumes.
    const teardownExtra: Array<() => Promise<void>> = [
      () => docker(["rm", "-f", result.containerName]).then(() => {}).catch(() => {}),
      staged.cleanup,
      seed.cleanup,
    ];
    return makeResult(result.client, "stdio", result.descriptor, serverKey(parsed), resolvedVersion, teardownExtra, clientInfo);
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
  clientInfo: PresentedClientInfo,
): Promise<Client | null> {
  const client = new Client(clientInfo, { capabilities: {} });
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
  clientInfo: PresentedClientInfo,
): Promise<Client> {
  const client = new Client(clientInfo, { capabilities: {} });
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
  clientInfo: PresentedClientInfo,
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
    clientInfo,
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
  if (p.registry === "github") {
    throw new Error(
      "github servers require docker isolation — they are cloned, built, and run sandboxed, never on the host. Set LITMUS_STDIO_ISOLATION=docker.",
    );
  }
  throw new Error(
    `registry "${p.registry}" is not launchable over stdio (only npm/pypi). Use an https:// URL for a remote MCP server.`,
  );
}
