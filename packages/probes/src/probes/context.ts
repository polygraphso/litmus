import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDef } from "@polygraph/core";

/** What every probe receives: the live client, the tool surface, planted canaries. */
export interface ProbeContext {
  client: Client;
  tools: ToolDef[];
  /** Per-run unique canary strings (planted by C-03; available to all probes). */
  canaries: string[];
  /** Whether a network sandbox is available (governs C-02 / probe 4.2). */
  dockerAvailable: boolean;
}
