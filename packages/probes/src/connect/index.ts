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
import {
  parseServerRef,
  serverKey,
  type ParsedServerRef,
  type TargetDescriptor,
  type TargetKind,
} from "@polygraph/core";

export interface StdioCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
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

const CLIENT_INFO = { name: "polygraph-litmus", version: "0.0.0" };

export async function connectTarget(input: TargetInput): Promise<ConnectedTarget> {
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
      env: { ...getDefaultEnvironment(), ...(input.env ?? {}) },
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    const cmdline = [input.command, ...(input.args ?? [])].join(" ");
    descriptor = { kind, command: cmdline, url: null };
    serverRef = cmdline;
  } else if (/^https?:\/\//i.test(input)) {
    kind = "http";
    transport = new StreamableHTTPClientTransport(new URL(input));
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
      env: getDefaultEnvironment(),
    });
    descriptor = { kind, command: [launch.command, ...launch.args].join(" "), url: null };
    serverRef = serverKey(parsed);
  }

  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);

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
