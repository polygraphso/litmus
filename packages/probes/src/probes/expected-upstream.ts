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
 *   - medium  — the egress host's REGISTRABLE label (the second-from-last label)
 *               matches a brand token drawn from the surface + package owner/name.
 *
 * Guardrails: whole-label (never substring) matching, a generic-label stoplist, a
 * min-length filter, and — crucially — the medium tier matches only the host's
 * registrable label, so a lookalike that stuffs a brand into a subdomain of an
 * attacker domain (`openai.evil-cdn.com`, registrable label `evil-cdn`) is NOT
 * cleared. The ultimate backstop is independent: C-03 probe 4.2 still fails a
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

/** Split a blob into candidate brand tokens (non-generic, min-length, non-numeric). */
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

/** Registrable-domain approximation: the last two labels (`openai.com`). */
function registrableDomain(labels: string[]): string {
  return labels.slice(-2).join(".");
}

/** Registrable label: the second-from-last label (`openai` in `api.openai.com`). */
function registrableLabel(labels: string[]): string | null {
  return labels.length >= 2 ? labels[labels.length - 2]! : null;
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
 *    comes only from a real host mention (high confidence).
 *  - medium (brand-label): the host's registrable (second-from-last) label is a
 *    known brand token. Deliberately NOT any subdomain label — that is what makes
 *    `openai.evil-cdn.com` (registrable label `evil-cdn`) fail to match `openai`.
 */
export function matchExpectedUpstream(host: string, signal: ExpectedUpstreamSignal): UpstreamMatch | null {
  const labels = hostLabels(host);
  if (labels.length < 2) return null; // a bare label / IP is never an inferred upstream
  const h = labels.join(".");
  const hReg = registrableDomain(labels);

  for (const m of signal.hostMentions) {
    const mLabels = hostLabels(m);
    if (mLabels.length < 2) continue;
    if (h === m || h.endsWith(`.${m}`) || m.endsWith(`.${h}`) || registrableDomain(mLabels) === hReg) {
      return { via: "host-mention", token: m };
    }
  }

  const reg = registrableLabel(labels);
  if (reg && reg.length >= MIN_LABEL_LEN && !GENERIC_LABELS.has(reg) && signal.brandLabels.has(reg)) {
    return { via: "brand-label", token: reg };
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
