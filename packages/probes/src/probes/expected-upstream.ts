/**
 * Expected-upstream inference for C-02 probe 2.2.
 *
 * An API-wrapper MCP server whose tool transparently calls the API it wraps — an
 * `openai_chat` tool reaching `api.openai.com` — makes an *undeclared* egress
 * attempt, but not an unexpected one: the upstream is the very API the tool
 * advertises. This pure unit lets probe 2.2 tell that honest pattern apart from
 * egress to a host with no relationship to the advertised surface.
 *
 * The signal is derived ONLY from the server's own public tool surface + its
 * package identity — a form of self-disclosure. Two tiers:
 *   - strong  — the egress host is named verbatim in the tool surface text.
 *   - medium  — the egress host's registrable label (the label immediately left of
 *               the public suffix, suffix-aware) matches a brand token drawn from
 *               the surface + package owner/name. The brand tier fires only on
 *               plain-TLD hosts (suffixLabelCount === 1): `slack` clears an
 *               author-owned `slack.xyz` but does NOT clear a shared-tenant
 *               `slack.fly.dev` — those clear only via the strong tier when the
 *               surface names them verbatim. This keeps the brand tier restricted
 *               to domains the owner controls, backstopped by C-03 canary checks.
 *
 * Guardrails: whole-label (never substring) matching, a generic-label stoplist, a
 * min-length filter, and — crucially — the medium tier matches only the host's
 * registrable label, so a lookalike that stuffs a brand into a subdomain of an
 * attacker domain (`openai.evil-cdn.com`, registrable label `evil-cdn`) is NOT
 * cleared. Multi-part public suffixes / shared-tenant domains (`github.io`,
 * `vercel.app`, etc.) are treated as their own suffix level: `attacker.github.io`
 * and `foo.github.io` are separately registrable and do not share a registrable
 * domain. The ultimate backstop is independent: C-03 probe 4.2 still fails a
 * server that phones home a planted canary, regardless of C-02.
 */

import type { ToolDef } from "@polygraph/core";
import { parseServerRef } from "@polygraph/core";
import { normalizeHost } from "./host-match.js";

/** Generic host/URL/package labels that carry no brand signal on their own. */
const GENERIC_LABELS: ReadonlySet<string> = new Set([
  "apis", "apps", "www", "web", "http", "https", "cloud", "gateway", "service",
  "services", "server", "servers", "client", "clients", "proxy", "edge", "data",
  "static", "assets", "auth", "oauth", "login", "admin", "tool", "tools", "prod",
  "test", "tests", "staging", "sandbox", "public", "core",
]);

/**
 * Multi-part public suffixes / shared-tenant domains, where each subdomain is a
 * separate, independently-registrable owner. The registrable domain is one label
 * deeper than the trailing two, so `attacker.github.io` must not be treated as
 * sharing an owner with `foo.github.io`. Hardcoded (not a public-suffix-list
 * dependency) — extend as new shared-tenant hosts appear.
 */
const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
  "herokuapp.com", "web.app", "firebaseapp.com", "fly.dev", "onrender.com", "run.app",
  "co.uk", "com.br", "com.au", "co.jp", "co.in", "com.mx",
]);

/** Min token length to count as a brand label (drops `io`, `co`, `api`, `get`, …). */
const MIN_LABEL_LEN = 4;

export interface ExpectedUpstreamSignal {
  /** Hosts/domains found verbatim in the tool surface text (normalized). Strong tier. */
  hostMentions: string[];
  /** Non-generic brand tokens from the surface text + package owner/name. Medium tier. */
  brandLabels: Set<string>;
}

/** Domain-like tokens: one or more dot-separated labels ending in an alphabetic
 *  TLD (2–24). Excludes IPs and version strings (`1.0.0` has a numeric last label). */
const HOST_RE = /[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}/g;

/** Serialize a tool's surface (name + description + schema) into one lowercased blob. */
function toolText(t: ToolDef): string {
  let schema = "";
  try {
    schema = t.inputSchema == null ? "" : JSON.stringify(t.inputSchema);
  } catch {
    schema = "";
  }
  return `${t.name} ${t.description} ${schema}`.toLowerCase();
}

/**
 * Split a blob into candidate brand tokens (non-generic, min-length, non-numeric).
 * Splitting on non-alphanumerics means a hyphenated registrable label (`evil-cdn`)
 * is never returned whole, so it can never brand-match — an intentional fail-safe.
 */
function brandTokens(text: string): string[] {
  return text
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_LABEL_LEN && !GENERIC_LABELS.has(w) && !/^\d+$/.test(w));
}

/**
 * Build the expected-upstream signal from the tool surface + package identity.
 * Pure and deterministic; empty tools/owner/name yield an empty signal, so a run
 * with no signal behaves exactly as it did before this pass existed.
 */
export function expectedUpstreamSignal(
  tools: readonly ToolDef[],
  owner: string | null,
  name: string | null,
): ExpectedUpstreamSignal {
  const blob = tools.map(toolText).join(" ");
  const hostMentions = [...new Set((blob.match(HOST_RE) ?? []).map(normalizeHost))].filter((h) => h.length > 0);
  const brandLabels = new Set<string>(brandTokens(blob));
  // Package identity is self-disclosure too: `@openai/mcp`, `notion-mcp-server`.
  for (const id of [owner, name]) {
    if (id) for (const tok of brandTokens(id.toLowerCase())) brandLabels.add(tok);
  }
  return { hostMentions, brandLabels };
}

/** Labels of a normalized host, e.g. `api.openai.com` → [api, openai, com]. */
function hostLabels(host: string): string[] {
  return normalizeHost(host)
    .split(".")
    .filter((l) => l.length > 0);
}

/** How many trailing labels form the public suffix: 2 for a known multi-part
 *  suffix (`github.io`), else 1 (a plain TLD). */
function suffixLabelCount(labels: string[]): number {
  return labels.length >= 2 && MULTI_PART_SUFFIXES.has(labels.slice(-2).join("."))
    ? 2
    : 1;
}

/** Registrable-domain approximation, suffix-aware: `api.openai.com` → `openai.com`,
 *  `attacker.github.io` → `attacker.github.io`. Only meaningful when
 *  {@link registrableLabel} is non-null. */
function registrableDomain(labels: string[]): string {
  return labels.slice(-(suffixLabelCount(labels) + 1)).join(".");
}

/** Registrable label: the label immediately left of the public suffix — `openai`
 *  in `api.openai.com`, `attacker` in `attacker.github.io`. Null when the host is
 *  only a suffix (`github.io`) or a bare TLD, i.e. it has no owner label. */
function registrableLabel(labels: string[]): string | null {
  const idx = labels.length - suffixLabelCount(labels) - 1;
  return idx >= 0 ? labels[idx]! : null;
}

export interface UpstreamMatch {
  via: "host-mention" | "brand-label";
  token: string;
}

/**
 * Decide whether an egress `host` is a plausible upstream for this surface, and
 * how it matched — or null when there is no relationship.
 *
 *  - strong (host-mention): the host equals, is a subdomain of, or shares its
 *    registrable domain with a host named in the surface. Subdomain flexibility
 *    comes only from a real host mention (high confidence). Shared-tenant domains
 *    (`github.io`, `vercel.app`, …) are suffix-aware: `attacker.github.io` and
 *    `foo.github.io` have different registrable domains and do not cross-clear.
 *  - medium (brand-label): the host's registrable label (suffix-aware) is a known
 *    brand token. Deliberately NOT any subdomain label — that is what makes
 *    `openai.evil-cdn.com` (registrable label `evil-cdn`) fail to match `openai`.
 *    On a shared-tenant domain the registrable label is the tenant prefix
 *    (`collector` in `collector.github.io`), not the platform name (`github`).
 */
export function matchExpectedUpstream(host: string, signal: ExpectedUpstreamSignal): UpstreamMatch | null {
  const labels = hostLabels(host);
  if (labels.length < 2) return null; // a bare label / IP is never an inferred upstream
  const hRegLabel = registrableLabel(labels);
  if (hRegLabel === null) return null; // bare TLD / bare public suffix — never an upstream
  const h = labels.join(".");
  const hReg = registrableDomain(labels);

  for (const m of signal.hostMentions) {
    const mLabels = hostLabels(m);
    if (mLabels.length < 2 || registrableLabel(mLabels) === null) continue;
    const mNorm = mLabels.join(".");
    if (h === mNorm || h.endsWith(`.${mNorm}`) || mNorm.endsWith(`.${h}`) || registrableDomain(mLabels) === hReg) {
      return { via: "host-mention", token: m };
    }
  }

  if (
    suffixLabelCount(labels) === 1 &&
    hRegLabel.length >= MIN_LABEL_LEN &&
    !GENERIC_LABELS.has(hRegLabel) &&
    signal.brandLabels.has(hRegLabel)
  ) {
    return { via: "brand-label", token: hRegLabel };
  }
  return null;
}

/** Boolean convenience wrapper over {@link matchExpectedUpstream}. */
export function isExpectedUpstream(host: string, signal: ExpectedUpstreamSignal): boolean {
  return matchExpectedUpstream(host, signal) !== null;
}

/**
 * Build the signal for a run, deriving owner/name from the server ref. A ref that
 * doesn't parse (a remote URL, an unpinned path) yields owner/name = null, so only
 * the tool-surface text contributes.
 */
export function upstreamSignalForRef(tools: readonly ToolDef[], serverRef: string): ExpectedUpstreamSignal {
  let owner: string | null = null;
  let name: string | null = null;
  try {
    const p = parseServerRef(serverRef);
    owner = p.owner;
    name = p.name;
  } catch {
    /* remote / unparseable ref → surface-text-only signal */
  }
  return expectedUpstreamSignal(tools, owner, name);
}
