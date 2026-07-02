import { describe, it, expect } from "vitest";
import type { ToolDef } from "@polygraph/core";
import {
  expectedUpstreamSignal,
  matchExpectedUpstream,
  isExpectedUpstream,
  upstreamSignalForRef,
} from "./expected-upstream.js";

const tool = (name: string, description = "", inputSchema: unknown = null): ToolDef => ({
  name,
  description,
  inputSchema,
});

describe("expectedUpstreamSignal — extract host mentions + brand labels", () => {
  it("pulls a verbatim host out of a tool description", () => {
    const s = expectedUpstreamSignal(
      [tool("openai_chat", "Calls https://api.openai.com/v1/chat/completions.")],
      null,
      null,
    );
    expect(s.hostMentions).toContain("api.openai.com");
    expect(s.brandLabels.has("openai")).toBe(true);
  });

  it("derives brand labels from names + package owner/name, minus generic/short tokens", () => {
    const s = expectedUpstreamSignal([tool("figma_get_file", "Fetch a Figma file")], "figma", "figma-mcp-server");
    expect(s.brandLabels.has("figma")).toBe(true);
    // generic + short tokens never become brand labels
    expect(s.brandLabels.has("api")).toBe(false);
    expect(s.brandLabels.has("mcp")).toBe(false);
    expect(s.brandLabels.has("get")).toBe(false); // < min length
    expect(s.brandLabels.has("server")).toBe(false); // stoplist
  });

  it("reads a host out of an inputSchema uri default", () => {
    const s = expectedUpstreamSignal(
      [tool("call", "invoke", { type: "object", properties: { url: { type: "string", default: "https://api.notion.com/v1" } } })],
      null,
      null,
    );
    expect(s.hostMentions).toContain("api.notion.com");
  });
});

describe("matchExpectedUpstream — tiers", () => {
  const openai = expectedUpstreamSignal(
    [tool("openai_chat", "Calls https://api.openai.com/v1/chat/completions.")],
    "openai",
    "openai-mcp",
  );

  it("strong tier: exact host mention matches", () => {
    expect(matchExpectedUpstream("api.openai.com", openai)?.via).toBe("host-mention");
  });

  it("strong tier: a subdomain of / shared registrable domain with a mention matches", () => {
    const s = expectedUpstreamSignal([tool("t", "see openai.com docs")], null, null);
    expect(isExpectedUpstream("api.openai.com", s)).toBe(true);
  });

  it("medium tier: registrable label matches a brand token with no host mention", () => {
    const s = expectedUpstreamSignal([tool("figma_get_file", "Fetch a Figma file")], "figma", "figma-mcp");
    const m = matchExpectedUpstream("api.figma.com", s);
    expect(m?.via).toBe("brand-label");
    expect(m?.token).toBe("figma");
  });

  it("rejects a lookalike that stuffs the brand into an attacker subdomain", () => {
    // registrable label of openai.evil-cdn.com is `evil-cdn`, not `openai`
    expect(matchExpectedUpstream("openai.evil-cdn.com", openai)).toBeNull();
  });

  it("rejects an unrelated host", () => {
    expect(matchExpectedUpstream("telemetry.acme-metrics.com", openai)).toBeNull();
  });

  it("never matches a bare label or an IP literal", () => {
    expect(matchExpectedUpstream("localhost", openai)).toBeNull();
    expect(matchExpectedUpstream("127.0.0.1", openai)).toBeNull();
  });

  it("an empty signal matches nothing (v10 behavior)", () => {
    const empty = expectedUpstreamSignal([], null, null);
    expect(isExpectedUpstream("api.openai.com", empty)).toBe(false);
  });
});

describe("upstreamSignalForRef — derive owner/name from the ref", () => {
  it("parses a scoped npm ref into owner/name signal", () => {
    const s = upstreamSignalForRef([tool("do_thing", "wraps the acmecorp api")], "npm/@acmecorp/acmecorp-mcp@1.2.3");
    expect(s.brandLabels.has("acmecorp")).toBe(true);
  });

  it("an unparseable ref (remote url) falls back to surface-text-only signal", () => {
    const s = upstreamSignalForRef([tool("openai_chat", "Calls https://api.openai.com/v1")], "https://mcp.example.com/sse");
    expect(s.hostMentions).toContain("api.openai.com");
  });
});

describe("matchExpectedUpstream — shared-tenant / multi-part suffix guards", () => {
  // A surface that mentions foo.github.io does NOT clear a different tenant's host
  // on the same shared platform — they are separately registrable.
  it("strong-tier shared-tenant reject: foo.github.io mention does not clear attacker.github.io", () => {
    const s = expectedUpstreamSignal(
      [tool("t", "see foo.github.io for details")],
      null,
      null,
    );
    expect(matchExpectedUpstream("attacker.github.io", s)).toBeNull();
  });

  // A bare multi-part suffix (github.io) as a mention must not anchor subdomain or
  // registrable-domain matches — it has no owner label of its own.
  it("bare-suffix mention does not anchor: github.io mention does not clear attacker.github.io", () => {
    const s = expectedUpstreamSignal(
      [tool("t", "see github.io for details")],
      null,
      null,
    );
    expect(matchExpectedUpstream("attacker.github.io", s)).toBeNull();
  });

  // A brand token drawn from `github`/`github-mcp` is `github`. On a shared-tenant
  // domain, `github` is the suffix label, not the registrable label — so brand tier
  // must not clear `collector.github.io`.
  it("brand-tier shared-tenant reject: github brand does not clear collector.github.io", () => {
    const s = expectedUpstreamSignal(
      [tool("github_issues", "List issues from a GitHub repository")],
      "github",
      "github-mcp",
    );
    expect(matchExpectedUpstream("collector.github.io", s)).toBeNull();
  });

  // Same-owner hosts on a shared-tenant platform must still match each other.
  it("same-owner on a suffix domain still clears: foo.github.io mention clears foo.github.io and api.foo.github.io", () => {
    const s = expectedUpstreamSignal(
      [tool("t", "see foo.github.io for details")],
      null,
      null,
    );
    expect(matchExpectedUpstream("foo.github.io", s)?.via).toBe("host-mention");
    expect(matchExpectedUpstream("api.foo.github.io", s)?.via).toBe("host-mention");
  });

  // Regression: ordinary TLD hosts must still clear as before.
  it("regression: api.openai.com still clears against openai.com mention and openai brand", () => {
    const sHM = expectedUpstreamSignal([tool("t", "see openai.com for details")], null, null);
    expect(isExpectedUpstream("api.openai.com", sHM)).toBe(true);
    const sBrand = expectedUpstreamSignal([tool("figma_file", "Fetch a Figma file")], "figma", "figma-mcp");
    expect(isExpectedUpstream("api.figma.com", sBrand)).toBe(true);
  });

  // A host that is itself a bare multi-part suffix (github.io) has no owner label
  // and must never be inferred as an upstream, regardless of signal.
  it("bare public-suffix host: github.io egress host is always null", () => {
    const s = expectedUpstreamSignal(
      [tool("github_issues", "List issues from a GitHub repository")],
      "github",
      "github-mcp",
    );
    expect(matchExpectedUpstream("github.io", s)).toBeNull();
  });
});
