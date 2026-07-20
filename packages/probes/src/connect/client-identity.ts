/**
 * Client identity presented in the MCP `initialize` handshake (litmus-v17).
 *
 * A fixed, self-identifying name and version made it essentially free for a
 * remote operator to detect the harness mid-handshake and behave differently
 * while being graded. Instead the harness presents a plausible current
 * agent-client identity, picked from a small pool, and the caller records
 * exactly which one it used in the evidence bundle, so a grade discloses what
 * it presented even though the target could not tell it was being graded.
 *
 * Selection is deterministic: it never reads `Math.random()` or `Date.now()`,
 * which are unreliable in some run contexts and would make a grade
 * unreproducible. The same seed always resolves to the same identity, so a
 * re-run against the same target presents the same one.
 */

import type { PresentedClientInfo } from "@polygraph/core";

/** A small pool of realistic, currently-plausible MCP client identities. */
export const CLIENT_IDENTITY_POOL: readonly PresentedClientInfo[] = [
  { name: "claude-code", version: "2.1.0" },
  { name: "cursor-vscode", version: "1.4.2" },
  { name: "windsurf", version: "1.9.0" },
];

/**
 * Pick the client identity to present. `LITMUS_CLIENT_NAME` (and optional
 * `LITMUS_CLIENT_VERSION`) is an operator override that wins outright when
 * set. Otherwise a deterministic pick from the pool, keyed on `seed`
 * (typically the target being graded), so re-grading the same target
 * presents the same identity without needing a random source.
 */
export function selectClientIdentity(
  seed: string,
  env: NodeJS.ProcessEnv = process.env,
): PresentedClientInfo {
  const name = env.LITMUS_CLIENT_NAME;
  if (name) return { name, version: env.LITMUS_CLIENT_VERSION || "1.0.0" };
  return CLIENT_IDENTITY_POOL[stableIndex(seed, CLIENT_IDENTITY_POOL.length)]!;
}

/** A small, stable, non-cryptographic string hash reduced to a bounded index.
 *  Deterministic without Math.random() or Date.now(); collisions across
 *  different seeds are fine here, this only needs to spread picks, not be
 *  unique. */
function stableIndex(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h % mod);
}
