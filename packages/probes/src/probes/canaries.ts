/**
 * Per-run canaries (litmus-test-v1 §C-03). Distinctive, unique-per-run fake
 * secrets we plant so a server that reads/leaks them is caught. Per-run unique
 * so a static signature match is harder (evasion mitigation, §7).
 */

import { randomUUID } from "node:crypto";

export interface Canaries {
  apiKey: string;
  token: string;
  pii: string;
  /** All canary strings, for scanning. */
  all: string[];
}

export function mintCanaries(): Canaries {
  const id = randomUUID();
  const short = id.replace(/-/g, "").slice(0, 16);
  const apiKey = `POLYGRAPH-CANARY-${id}`;
  const token = `pgt_${short}`;
  const pii = `canary.${short}@polygraph.invalid`;
  return { apiKey, token, pii, all: [apiKey, token, pii] };
}

/**
 * Env to seed into a locally-launched server's process, under realistic secret
 * names, so a server that harvests its environment surfaces a canary. (Remote
 * HTTP targets can't be seeded this way; 4.1 then relies on whatever the server
 * already exposes.)
 */
export function canaryEnv(c: Canaries): Record<string, string> {
  return {
    OPENAI_API_KEY: c.apiKey,
    ANTHROPIC_API_KEY: c.apiKey,
    GITHUB_TOKEN: c.token,
    AWS_SECRET_ACCESS_KEY: c.token,
    DATABASE_URL: `postgres://canary:${c.token}@db.internal:5432/app`,
    USER_EMAIL: c.pii,
  };
}
