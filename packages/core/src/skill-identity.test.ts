import { describe, it, expect } from "vitest";
import { parseSkillRef, formatSkillRef, skillKey, SkillRefParseError } from "./skill-identity.js";

describe("parseSkillRef", () => {
  it("parses source/owner/name#path@ref", () => {
    expect(parseSkillRef("github/anthropic/skills#document-skills/pdf@a1b2c3d")).toEqual({
      source: "github",
      owner: "anthropic",
      name: "skills",
      path: "document-skills/pdf",
      ref: "a1b2c3d",
    });
  });

  it("parses a bare marketplace coordinate (no path, no pin)", () => {
    expect(parseSkillRef("marketplace/acme/format-markdown")).toEqual({
      source: "marketplace",
      owner: "acme",
      name: "format-markdown",
      path: null,
      ref: null,
    });
  });

  it("keeps an npm scope's leading @ out of the version delimiter", () => {
    expect(parseSkillRef("npm/@acme/skills#skills/tidy@1.4.0")).toEqual({
      source: "npm",
      owner: "@acme",
      name: "skills",
      path: "skills/tidy",
      ref: "1.4.0",
    });
  });

  it("round-trips through formatSkillRef", () => {
    const ref = "github/anthropic/skills#document-skills/pdf@a1b2c3d";
    expect(formatSkillRef(parseSkillRef(ref))).toBe(ref);
  });

  it("rejects unknown sources (server registries are a separate namespace)", () => {
    expect(() => parseSkillRef("pypi/x/y")).toThrow(SkillRefParseError);
  });

  it("rejects argument-injection-shaped segments", () => {
    expect(() => parseSkillRef("github/--evil/x")).toThrow(SkillRefParseError);
    expect(() => parseSkillRef("github/o/r#../../etc/passwd")).toThrow(SkillRefParseError);
    expect(() => parseSkillRef("github/o/r@-bad")).toThrow(SkillRefParseError);
  });
});

describe("skillKey — versionless identity, path-inclusive", () => {
  it("drops the @ref pin but keeps the #path (a repo holds many skills)", () => {
    expect(skillKey(parseSkillRef("github/anthropic/skills#document-skills/pdf@a1b2c3d"))).toBe(
      "github/anthropic/skills#document-skills/pdf",
    );
  });
  it("handles a pathless coordinate", () => {
    expect(skillKey(parseSkillRef("marketplace/acme/format-markdown"))).toBe("marketplace/acme/format-markdown");
  });
});
