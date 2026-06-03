import { describe, it, expect } from "vitest";
import { canonicalStringify } from "./canonical.js";

describe("canonicalStringify", () => {
  it("is stable regardless of key insertion order", () => {
    expect(canonicalStringify({ b: 1, a: { y: 2, x: 3 } })).toBe(
      canonicalStringify({ a: { x: 3, y: 2 }, b: 1 }),
    );
  });

  it("sorts nested keys but preserves array order", () => {
    expect(canonicalStringify({ z: [{ b: 1, a: 2 }, 3] })).toBe('{"z":[{"a":2,"b":1},3]}');
  });

  it("preserves raw string bytes", () => {
    const zwsp = String.fromCharCode(0x200b);
    expect(canonicalStringify({ d: `x${zwsp}y` })).not.toBe(canonicalStringify({ d: "xy" }));
  });
});
