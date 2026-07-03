/**
 * Identity of the connected MCP client (the "agent"), from the initialize
 * handshake — e.g. "claude-ai/1.2.0". Undefined before initialize or when the
 * client didn't announce itself. Used to attribute `request_grade` calls
 * without asking the user for contact details.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function clientAgentId(server: McpServer): string | undefined {
  const client = server.server.getClientVersion();
  if (!client?.name) return undefined;
  return client.version ? `${client.name}/${client.version}` : client.name;
}
