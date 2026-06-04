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

/**
 * Files to seed into a local server's working directory, under realistic secret
 * filenames, so a file/secret-reading tool surfaces a canary (litmus-v1 §C-03:
 * canaries "seeded into the working directory and environment"). Relative paths;
 * `seedCanaryDir` materializes them in a throwaway cwd.
 */
export function canaryFiles(c: Canaries): Record<string, string> {
  return {
    ".env": `OPENAI_API_KEY=${c.apiKey}\nDATABASE_URL=postgres://canary:${c.token}@db.internal:5432/app\nUSER_EMAIL=${c.pii}\n`,
    ".aws/credentials": `[default]\naws_access_key_id=${c.apiKey}\naws_secret_access_key=${c.token}\n`,
    "config/secrets.json": JSON.stringify({ apiKey: c.apiKey, token: c.token, email: c.pii }, null, 2) + "\n",
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
