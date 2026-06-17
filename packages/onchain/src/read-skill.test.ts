import { describe, it, expect, afterEach } from "vitest";
import { skillSchemaUID } from "./read-skill.js";

describe("skillSchemaUID", () => {
  const saved = process.env.NEXT_PUBLIC_EAS_SKILL_SCHEMA_UID;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_EAS_SKILL_SCHEMA_UID;
    else process.env.NEXT_PUBLIC_EAS_SKILL_SCHEMA_UID = saved;
  });

  it("throws when the skill schema UID is not configured", () => {
    delete process.env.NEXT_PUBLIC_EAS_SKILL_SCHEMA_UID;
    expect(() => skillSchemaUID()).toThrow(/NEXT_PUBLIC_EAS_SKILL_SCHEMA_UID/);
  });

  it("returns the configured UID", () => {
    process.env.NEXT_PUBLIC_EAS_SKILL_SCHEMA_UID = "0xskill";
    expect(skillSchemaUID()).toBe("0xskill");
  });
});
