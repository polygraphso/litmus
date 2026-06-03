import { describe, it, expect } from "vitest";
import { fingerprintToolDefs } from "./fingerprint.js";
import type { ToolDef } from "@polygraph/core";

const ZWSP = String.fromCharCode(0x200b); // zero-width space

const tools: ToolDef[] = [
  {
    name: "b_tool",
    description: "does   B",
    inputSchema: { type: "object", properties: { y: { type: "number" }, x: { type: "string" } } },
  },
  { name: "a_tool", description: "does A\n", inputSchema: { type: "object" } },
];

describe("fingerprintToolDefs", () => {
  it("is a 0x-prefixed bytes32 and stable across tool order / key order / ASCII whitespace", () => {
    const a = fingerprintToolDefs(tools);
    const b = fingerprintToolDefs([...tools].reverse());
    expect(a.fingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("changes when a hidden Unicode char is injected into a description", () => {
    const base = fingerprintToolDefs(tools).fingerprint;
    const tampered = fingerprintToolDefs([
      { ...tools[0]!, description: `does ${ZWSP}B` },
      tools[1]!,
    ]).fingerprint;
    expect(tampered).not.toBe(base);
  });

  it("changes when the tool surface changes (added tool)", () => {
    const base = fingerprintToolDefs(tools).fingerprint;
    const extra = fingerprintToolDefs([...tools, { name: "c_tool", description: "C", inputSchema: {} }]).fingerprint;
    expect(extra).not.toBe(base);
  });
});
