/**
 * Server-identity helpers for refs of the form `{registry}/{owner}/{name}@{version}`.
 *
 * Vendored verbatim from the `core` repo (`packages/core/src/identity.ts`) so
 * this standalone repo has no cross-repo dependency. Keep in sync if core's
 * parser changes.
 *
 * Examples:
 *   npm/@modelcontextprotocol/server-filesystem@0.4.2   (scoped npm)
 *   npm/lodash@4.17.21                                  (unscoped npm)
 *   pypi/mcp-server-git@1.0.0                           (pypi — no owner)
 *   github/anthropic/mcp-server-foo@v0.1.3              (github — owner required)
 *
 * Owner rules per registry:
 *   - npm: optional (scoped packages have `@scope` as owner; unscoped omit it)
 *   - pypi: always absent (PyPI packages are flat — no owner namespacing)
 *   - github: required (always `{owner}/{repo}`)
 *
 * npm scopes are preserved (the `@` in `@modelcontextprotocol` belongs to the
 * scope, not the version delimiter).
 */

import type { Registry } from "./types.js";

export interface ParsedServerRef {
  registry: Registry;
  /** Null for unscoped npm and for all pypi refs; required for github. */
  owner: string | null;
  name: string;
  version: string | null;
}

const REGISTRIES = new Set<Registry>(["npm", "pypi", "github"]);

// Each segment must start with an alphanumeric and contain only registry-safe
// characters. This is a security control, not just hygiene: parsed segments are
// passed as arguments to `npx`/`uvx`/`npm install`, so a segment beginning with
// "-" (or containing path/shell metacharacters, whitespace, etc.) would be an
// argument-injection vector (e.g. `npm/--registry=evil` repointing the install).
// An owner may carry a leading "@" (npm scope); names and versions may not.
const OWNER_RE = /^@?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;

export class ServerRefParseError extends Error {
  constructor(ref: string, reason: string) {
    super(`Invalid server ref "${ref}": ${reason}`);
    this.name = "ServerRefParseError";
  }
}

/**
 * Parse a server ref. Version is optional; if present it must follow the final `@`.
 * The owner segment may itself start with `@` (npm scope).
 */
export function parseServerRef(ref: string): ParsedServerRef {
  const firstSlash = ref.indexOf("/");
  if (firstSlash === -1) {
    throw new ServerRefParseError(ref, "expected `{registry}/...`");
  }
  const registry = ref.slice(0, firstSlash);
  if (!REGISTRIES.has(registry as Registry)) {
    throw new ServerRefParseError(
      ref,
      `unknown registry "${registry}" (expected one of: ${[...REGISTRIES].join(", ")})`,
    );
  }
  const rest = ref.slice(firstSlash + 1);

  // Strip the version suffix if present. Search from the right, but skip the
  // leading `@` of an npm scope (position 0).
  const versionAt = rest.lastIndexOf("@");
  let pathPart: string;
  let version: string | null;
  if (versionAt > 0) {
    pathPart = rest.slice(0, versionAt);
    version = rest.slice(versionAt + 1);
    if (version.length === 0) {
      throw new ServerRefParseError(ref, "empty version after `@`");
    }
    if (!VERSION_RE.test(version)) {
      throw new ServerRefParseError(ref, "version contains disallowed characters");
    }
  } else {
    pathPart = rest;
    version = null;
  }

  const lastSlash = pathPart.lastIndexOf("/");
  let owner: string | null;
  let name: string;
  if (lastSlash === -1) {
    if (registry === "github") {
      throw new ServerRefParseError(ref, "github requires `{owner}/{repo}`");
    }
    // Unscoped npm package (`npm/lodash`) or a pypi package (`pypi/mcp-server-git`).
    owner = null;
    name = pathPart;
    if (!name) {
      throw new ServerRefParseError(ref, "empty name segment");
    }
  } else {
    owner = pathPart.slice(0, lastSlash);
    name = pathPart.slice(lastSlash + 1);
    if (!owner || !name) {
      throw new ServerRefParseError(ref, "empty owner or name segment");
    }
  }

  if (owner !== null && !OWNER_RE.test(owner)) {
    throw new ServerRefParseError(ref, "owner contains disallowed characters");
  }
  if (!NAME_RE.test(name)) {
    throw new ServerRefParseError(ref, "name contains disallowed characters");
  }

  return { registry: registry as Registry, owner, name, version };
}

export function formatServerRef(parts: ParsedServerRef): string {
  const base = parts.owner
    ? `${parts.registry}/${parts.owner}/${parts.name}`
    : `${parts.registry}/${parts.name}`;
  return parts.version ? `${base}@${parts.version}` : base;
}

/** Identity of a server without a version pin. */
export function serverKey(parts: Pick<ParsedServerRef, "registry" | "owner" | "name">): string {
  return parts.owner
    ? `${parts.registry}/${parts.owner}/${parts.name}`
    : `${parts.registry}/${parts.name}`;
}
