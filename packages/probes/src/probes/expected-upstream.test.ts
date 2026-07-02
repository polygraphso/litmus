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
