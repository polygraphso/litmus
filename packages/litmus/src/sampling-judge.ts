/**
 * Agent-native judge: when the litmus runs INSIDE an MCP host (Claude Code, Cursor,
 * …) that supports sampling, the host's own model does the judging via MCP
 * `sampling/createMessage`. No API key, provider-agnostic by definition (whatever
 * the host runs). If the connected client does not advertise the sampling
 * capability, `complete` throws and the caller falls back (env key) or skips the
 * judged axes — the litmus core never requires a key.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Judge } from "@polygraph/probes";

/** True if the connected client advertised the sampling capability. */
export function clientSupportsSampling(server: McpServer): boolean {
  return Boolean(server.server.getClientCapabilities()?.sampling);
}

export function samplingJudge(server: McpServer): Judge {
  return {
    id: "mcp-sampling",
    async complete(system, user) {
      if (!clientSupportsSampling(server)) {
        throw new Error("MCP client does not support sampling");
      }
      const res = await server.server.createMessage({
        systemPrompt: system,
        maxTokens: 1024,
        messages: [{ role: "user", content: { type: "text", text: user } }],
      });
      return res.content.type === "text" ? res.content.text : "";
    },
  };
}
