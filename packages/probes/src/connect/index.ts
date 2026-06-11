/**
 * Connect to a target MCP server the way an agent would (technical-design §3).
 *
 * - a local package ref (`npm/…`, `pypi/…`) is launched as a subprocess over
 *   **stdio** (`npx -y` / `uvx`);
 * - a remote `https://` URL is reached over **Streamable HTTP**;
 * - an explicit `{command,args}` (for in-repo demo servers and tests) launches
 *   over stdio directly.
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
  prepareSeedVolume,
  IsolationUnsupportedError,
  type SeedVolume,
} from "./container.js";
import { docker, ensureImage, stageNpmPackage, type StagedPackage } from "../docker/staging.js";
import { randomUUID } from "node:crypto";

export { IsolationUnsupportedError } from "./container.js";

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
   * "docker" runs an npm target ONLY inside the hardened container (§2.6) and
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

  let kind: TargetKind;
  let descriptor: TargetDescriptor;
  let serverRef: string;
  let resolvedVersion: string | null = null;
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  // Container path: volumes to remove after the client closes (npm + isolation).
  const teardownExtra: Array<() => Promise<void>> = [];

  if (typeof input !== "string") {
    // An explicit stdio command can't be sandboxed (we don't know its registry
    // identity, and the egress runner already wraps `docker run` itself). Fail
    // closed rather than silently executing it on the host under isolation.
    if (isolated) {
      throw new IsolationUnsupportedError(
        "docker isolation is unsupported for an explicit stdio command — only an npm ref can be containerized",
      );
    }
    kind = "stdio";
    transport = new StdioClientTransport({
      command: input.command,
      args: input.args ?? [],
      env: { ...getDefaultEnvironment(), ...(opts.seedEnv ?? {}), ...(input.env ?? {}) },
      ...(input.cwd ?? opts.seedCwd ? { cwd: input.cwd ?? opts.seedCwd } : {}),
    });
    const cmdline = [input.command, ...(input.args ?? [])].join(" ");
    descriptor = { kind, command: cmdline, url: null };
    serverRef = input.serverRef ?? cmdline;
  } else if (/^https?:\/\//i.test(input)) {
    // Isolation is stdio-only; an https target is unaffected (hosted rejects
    // https at submit for other reasons — see the SSRF note in the plan).
    kind = "http";
    // SSRF guard: refuse targets that resolve to private/reserved addresses
    // (cloud metadata, loopback, internal services) before opening a connection.
    await assertPublicHttpUrl(input);
    const headers =
      opts.httpHeaders && Object.keys(opts.httpHeaders).length > 0 ? opts.httpHeaders : undefined;
    transport = new StreamableHTTPClientTransport(
      new URL(input),
      headers ? { requestInit: { headers }, fetch: sameOriginAuthFetch(input, headers) } : undefined,
    );
    descriptor = { kind, command: null, url: input };
    serverRef = input;
  } else {
    const parsed = parseServerRef(input);
    kind = "stdio";

    if (isolated) {
      if (parsed.registry !== "npm") {
        throw new IsolationUnsupportedError(
          `docker isolation is unsupported for ${parsed.registry} refs — only npm refs can be containerized`,
        );
      }
      // Containerized npm path. Stage the install (network on, --ignore-scripts,
      // no target code runs) into a read-only volume, seed canaries into a second
      // read-only volume, then launch the target ONLY inside the hardened
      // container. Any failure here throws — there is no host-exec fallback.
      const spec =
        (parsed.owner ? `${parsed.owner}/${parsed.name}` : parsed.name) + (parsed.version ? `@${parsed.version}` : "");
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
        const launch = containerLaunch({
          entry: staged.entry,
          stageVolume: staged.volume,
          seedVolume: seed.volume,
          // Canaries travel INTO the container via -e, NOT via the docker CLI's
          // own env (the CLI runs on the secrets-bearing host).
          canaryEnv: opts.seedEnv ?? {},
          ...(opts.runLabel ? { runLabel: opts.runLabel } : {}),
          ...(process.env.LITMUS_DOCKER_RUNTIME ? { runtime: process.env.LITMUS_DOCKER_RUNTIME } : {}),
        });
        // Name the container so teardown can force-remove it. A `node` server
        // launched over `docker run -i` does NOT exit when its stdin closes, so
        // `--rm` never fires on `client.close()` alone — without an explicit
        // `docker rm -f` the container (and the volumes it holds) would leak.
        // `--name` is orchestration, not a §2.6 hardening flag.
        const containerName = `pg-connect-${randomUUID().slice(0, 8)}`;
        // Insert `--name <name>` right after `run` (launch.args[0]).
        const namedArgs = [launch.args[0]!, "--name", containerName, ...launch.args.slice(1)];
        transport = new StdioClientTransport({
          command: launch.command,
          args: namedArgs,
          // Default env only: no host secrets, no canaries (those are -e args).
          env: getDefaultEnvironment(),
        });
        // Record the §2.6 command line (without the orchestration-only --name, so
        // the bundle's recorded command line matches the locked contract).
        descriptor = { kind, command: [launch.command, ...launch.args].join(" "), url: null };
        resolvedVersion = staged.resolvedVersion ?? parsed.version ?? null;
        const stagedCleanup = staged.cleanup;
        const seedCleanup = seed.cleanup;
        // Order matters: force-remove the container FIRST, so the volumes it
        // mounted can then be removed (a still-running container blocks `volume rm`).
        teardownExtra.push(
          () => docker(["rm", "-f", containerName]).then(() => {}).catch(() => {}),
          stagedCleanup,
          seedCleanup,
        );
      } catch (err) {
        // Roll back any volumes created before the failure, then rethrow — fail closed.
        if (seed) await seed.cleanup();
        if (staged) await staged.cleanup();
        throw err;
      }
      serverRef = serverKey(parsed);
    } else {
      const launch = launchForRef(parsed);
      resolvedVersion = parsed.version ?? null;
      transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env: { ...getDefaultEnvironment(), ...(opts.seedEnv ?? {}) },
        ...(opts.seedCwd ? { cwd: opts.seedCwd } : {}),
      });
      descriptor = { kind, command: [launch.command, ...launch.args].join(" "), url: null };
      serverRef = serverKey(parsed);
    }
  }

  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    // Bound the initialize handshake: a server that opens the connection but never
    // (or only trickles a) reply must not hang the harness indefinitely.
    await withConnectTimeout(client.connect(transport), transport);
  } catch (err) {
    // Connect failed: free any staged/seed volumes we already created.
    for (const c of teardownExtra) await c();
    throw err;
  }

  return {
    client,
    kind,
    descriptor,
    serverRef,
    resolvedVersion,
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

function launchForRef(p: ParsedServerRef): { command: string; args: string[] } {
  if (p.registry === "npm") {
    const spec = (p.owner ? `${p.owner}/${p.name}` : p.name) + (p.version ? `@${p.version}` : "");
    return { command: "npx", args: ["-y", spec] };
  }
  if (p.registry === "pypi") {
    return { command: "uvx", args: [p.version ? `${p.name}@${p.version}` : p.name] };
  }
  throw new Error(
    `registry "${p.registry}" is not launchable over stdio (only npm/pypi). Use an https:// URL for a remote MCP server.`,
  );
}
