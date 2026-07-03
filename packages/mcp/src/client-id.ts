/**
 * Identity of the connected MCP client (the "agent"), from the initialize
 * handshake. Used to attribute lookup and grade-request calls without asking
 * the user for anything — software metadata only.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ClientAgentMeta {
  title?: string;
  websiteUrl?: string;
  description?: string;
  /** Capability keys the client declared (e.g. "sampling", "roots"). */
  capabilities?: string[];
}

export interface ClientAgent {
  /** e.g. "claude-code/2.1.199"; undefined when the client didn't announce itself. */
  agentId?: string;
  meta?: ClientAgentMeta;
}

/** "name/version" string, or undefined before initialize / unannounced clients. */
export function clientAgentId(server: McpServer): string | undefined {
  const client = server.server.getClientVersion();
  if (!client?.name) return undefined;
  return client.version ? `${client.name}/${client.version}` : client.name;
}

/** Full identity: id + whatever the handshake declared (title, website,
 *  description, capability keys). Everything optional; empty meta is omitted. */
export function clientAgent(server: McpServer): ClientAgent {
  const agentId = clientAgentId(server);
  const info = server.server.getClientVersion() as
    | { title?: string; websiteUrl?: string; description?: string }
    | undefined;
  const meta: ClientAgentMeta = {};
  if (typeof info?.title === "string" && info.title) meta.title = info.title;
  if (typeof info?.websiteUrl === "string" && info.websiteUrl) meta.websiteUrl = info.websiteUrl;
  if (typeof info?.description === "string" && info.description) meta.description = info.description;
  const caps = Object.keys(server.server.getClientCapabilities() ?? {});
  if (caps.length > 0) meta.capabilities = caps;
  const out: ClientAgent = {};
  if (agentId) out.agentId = agentId;
  if (Object.keys(meta).length > 0) out.meta = meta;
  return out;
}
