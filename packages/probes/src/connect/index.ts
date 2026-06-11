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
}

const CLIENT_INFO = { name: "polygraph-litmus", version: "0.0.0" };

export async function connectTarget(
  input: TargetInput,
  opts: ConnectOptions = {},
): Promise<ConnectedTarget> {
  let kind: TargetKind;
  let descriptor: TargetDescriptor;
  let serverRef: string;
  let resolvedVersion: string | null = null;
  let transport: StdioClientTransport | StreamableHTTPClientTransport;

  if (typeof input !== "string") {
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
    const launch = launchForRef(parsed);
    kind = "stdio";
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

  const client = new Client(CLIENT_INFO, { capabilities: {} });
  // Bound the initialize handshake: a server that opens the connection but never
  // (or only trickles a) reply must not hang the harness indefinitely.
  await withConnectTimeout(client.connect(transport), transport);

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
