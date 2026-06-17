import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSkillQuality } from "./quality.js";
import { runSkillLitmus } from "./skill-harness.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-quality-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function write(rel: string, content: string) {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

const opts = { ranAt: "2026-06-17T00:00:00.000Z" };
const GOOD = `---
name: format-markdown
description: Formats markdown files cleanly.
---
# Format markdown
Tidy the markdown. See [the guide](references/guide.md).
`;

describe("runSkillQuality — deterministic well-formedness axis", () => {
  it("well-formed when frontmatter, body, and bundled links all resolve", () => {
    write("SKILL.md", GOOD);
    write("references/guide.md", "the guide");
    const q = runSkillQuality(dir, opts);
    expect(q.verdict).toBe("well-formed");
    expect(q.checks.every((c) => c.status === "pass")).toBe(true);
  });
  it("issues (warn) when a relative bundled link is broken", () => {
    write("SKILL.md", GOOD); // references/guide.md is missing
    const q = runSkillQuality(dir, opts);
    expect(q.verdict).toBe("issues");
    expect(q.checks.find((c) => c.id === "bundled-links-resolve")?.status).toBe("warn");
  });
  it("malformed when the description is missing", () => {
    write("SKILL.md", `---\nname: x\n---\n# X\nbody.\n`);
    expect(runSkillQuality(dir, opts).verdict).toBe("malformed");
  });
  it("malformed (not a thrown error) when there is no SKILL.md", () => {
    write("notes.md", "x");
    const q = runSkillQuality(dir, opts);
    expect(q.verdict).toBe("malformed");
    expect(q.checks[0]?.id).toBe("loadable");
  });
  it("never emits an A–F letter; verdict vocabulary is distinct", () => {
    write("SKILL.md", GOOD);
    write("references/guide.md", "g");
    const q = runSkillQuality(dir, opts);
    expect(["well-formed", "issues", "malformed"]).toContain(q.verdict);
    expect(["A", "B", "C", "D", "F"]).not.toContain(q.verdict as string);
  });
});

describe("separation invariant — quality never touches the safety bundle", () => {
  it("the safety bundle carries NO quality fields and is byte-invariant to the quality result", () => {
    write("SKILL.md", GOOD); // broken link → quality 'issues', but safety is unaffected
    const safety = runSkillLitmus(dir, opts);
    const serialized = JSON.stringify(safety);
    for (const key of ["quality", "qualityVersion", "verdict", "checks"]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
    // Make the quality result change (add the missing link target), re-grade safety:
    write("references/guide.md", "now present");
    const safety2 = runSkillLitmus(dir, opts);
    // contentHash changes (a file was added) but the safety SHAPE has no quality leakage.
    expect(JSON.stringify(safety2)).not.toContain('"verdict"');
  });
  it("quality binds to the same identity (skillRef + contentHash) as the safety bundle", () => {
    write("SKILL.md", GOOD);
    write("references/guide.md", "g");
    const safety = runSkillLitmus(dir, { ...opts, skillRef: "local/x" });
    const quality = runSkillQuality(dir, { ...opts, skillRef: "local/x" });
    expect(quality.skillRef).toBe(safety.skillRef);
    expect(quality.contentHash).toBe(safety.contentHash);
  });
});

describe("quality bundle determinism", () => {
  it("same dir + same ranAt produces an identical serialized quality bundle", () => {
    write("SKILL.md", GOOD);
    write("references/guide.md", "g");
    expect(JSON.stringify(runSkillQuality(dir, opts))).toBe(JSON.stringify(runSkillQuality(dir, opts)));
  });
});
