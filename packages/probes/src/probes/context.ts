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
  /**
   * Harness-controlled external content for C-01 probe 1.4 (indirect/passthrough
   * injection, litmus-v16): the injection-laced payload plus where a content-fetch
   * tool can reach it (seeded file path(s), and a loopback URL when the target has
   * host network). Absent when 1.4 can't run (e.g. remote/http target, no seed dir).
   */
  externalContent?: {
    payload: string;
    marker: string;
    /** Candidate paths (relative name + absolute) a path-tool can read for `payload`. */
    filePaths: string[];
    /** A loopback URL serving `payload`, or null when unreachable (docker/no host net). */
    url: string | null;
  };
}
