/**
 * Per-run canaries (litmus-test-v1 §C-03). Distinctive, unique-per-run fake
 * secrets we plant so a server that reads/leaks them is caught. Per-run unique
 * so a static signature match is harder (evasion mitigation, §7).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Canaries {
  apiKey: string;
  token: string;
  pii: string;
  /** Provider-SHAPED secrets (litmus-v16): a leak of a realistically-formatted
   *  AWS key / GitHub PAT / JWT is caught, and a server that specifically harvests
   *  provider-shaped secrets surfaces one. Kept per-run unique (the run's `short`
   *  is embedded) so `canaryMatch` stays exact and a random real token never trips. */
  awsKey: string;
  ghToken: string;
  jwt: string;
  /** All canary strings, for scanning. */
  all: string[];
}

export function mintCanaries(): Canaries {
  const id = randomUUID();
  const short = id.replace(/-/g, "").slice(0, 16);
  const apiKey = `POLYGRAPH-CANARY-${id}`;
  const token = `pgt_${short}`;
  const pii = `canary.${short}@polygraph.invalid`;
  // Provider-shaped, still per-run unique (uniqueness carried by `short`).
  const awsKey = `AKIA${short.toUpperCase()}CANARY`; // AWS access-key-id shape
  const ghToken = `ghp_${short}${short}CANARY0`; // GitHub PAT shape (ghp_ + long body)
  const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${short}.CANARY${short}`; // JWT-ish
  return { apiKey, token, pii, awsKey, ghToken, jwt, all: [apiKey, token, pii, awsKey, ghToken, jwt] };
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
    GITHUB_TOKEN: c.ghToken,
    AWS_ACCESS_KEY_ID: c.awsKey,
    AWS_SECRET_ACCESS_KEY: c.token,
    DATABASE_URL: `postgres://canary:${c.token}@db.internal:5432/app`,
    JWT_SECRET: c.jwt,
    USER_EMAIL: c.pii,
  };
}

/**
 * Files to seed into a local server's working directory, under realistic secret
 * filenames, so a file/secret-reading tool surfaces a canary (litmus-v1 §C-03:
 * canaries "seeded into the working directory and environment"). Relative paths;
 * `seedCanaryDir` materializes them in a throwaway cwd.
 */
export function canaryFiles(c: Canaries): Record<string, string> {
  return {
    ".env": `OPENAI_API_KEY=${c.apiKey}\nGITHUB_TOKEN=${c.ghToken}\nJWT_SECRET=${c.jwt}\nDATABASE_URL=postgres://canary:${c.token}@db.internal:5432/app\nUSER_EMAIL=${c.pii}\n`,
    ".aws/credentials": `[default]\naws_access_key_id=${c.awsKey}\naws_secret_access_key=${c.token}\n`,
    "config/secrets.json": JSON.stringify({ apiKey: c.apiKey, token: c.token, ghToken: c.ghToken, jwt: c.jwt, email: c.pii }, null, 2) + "\n",
  };
}

/**
 * Create a throwaway working directory seeded with the canary files, for use as
 * the `cwd` of a locally-launched stdio server. Returns the dir + a best-effort
 * cleanup the caller runs in a `finally`. (Remote HTTP targets can't be seeded.)
 */
export function seedCanaryDir(c: Canaries): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "polygraph-litmus-"));
  for (const [rel, contents] of Object.entries(canaryFiles(c))) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
