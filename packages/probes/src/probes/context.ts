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
  /**
   * Tool names classified as state-changing (e.g. `send`/`swap`/`delete`). The
   * dynamic probes skip actively calling these unless `allowStateChanging` is
   * set — they still get the static scan (1.1). See `tool-safety.ts`.
   */
  stateChangingTools: ReadonlySet<string>;
  /** When true, exercise every tool including state-changing ones. */
  allowStateChanging: boolean;
}
