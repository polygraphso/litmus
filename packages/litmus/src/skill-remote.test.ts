import { describe, expect, it } from "vitest";

import { parseRemoteSkillRef, tarballUrl } from "./skill-remote.js";

describe("parseRemoteSkillRef", () => {
  it("parses a github blob URL pointing at SKILL.md (grades its directory)", () => {
    expect(
      parseRemoteSkillRef(
        "https://github.com/polygraphso/litmus/blob/main/plugins/polygraph/skills/polygraph/SKILL.md",
      ),
    ).toEqual({
      owner: "polygraphso",
      repo: "litmus",
      gitRef: "main",
      subPath: "plugins/polygraph/skills/polygraph",
      canonicalRef: "github/polygraphso/litmus#plugins/polygraph/skills/polygraph",
    });
  });

  it("parses a github tree URL to a skill directory", () => {
    expect(
      parseRemoteSkillRef("https://github.com/BankrBot/skills/tree/main/skills/polygraph"),
    ).toEqual({
      owner: "BankrBot",
      repo: "skills",
      gitRef: "main",
      subPath: "skills/polygraph",
      canonicalRef: "github/BankrBot/skills#skills/polygraph",
    });
  });

  it("parses a bare repo URL as the repo root at HEAD", () => {
    expect(parseRemoteSkillRef("https://github.com/owner/skill-repo")).toEqual({
      owner: "owner",
      repo: "skill-repo",
      gitRef: "HEAD",
      subPath: "",
      canonicalRef: "github/owner/skill-repo",
    });
  });

  it("strips .git and trailing slashes from a repo URL", () => {
    const parsed = parseRemoteSkillRef("https://github.com/owner/skill-repo.git/");
    expect(parsed?.repo).toBe("skill-repo");
  });

  it("parses the github/<owner>/<repo>#<path> shorthand at HEAD", () => {
    expect(parseRemoteSkillRef("github/BankrBot/skills#skills/polygraph")).toEqual({
      owner: "BankrBot",
      repo: "skills",
      gitRef: "HEAD",
      subPath: "skills/polygraph",
      canonicalRef: "github/BankrBot/skills#skills/polygraph",
    });
  });

  it("parses the github/<owner>/<repo> shorthand without a path", () => {
    expect(parseRemoteSkillRef("github/owner/repo")?.subPath).toBe("");
  });

  it("rejects a blob URL that is a file other than SKILL.md", () => {
    expect(() =>
      parseRemoteSkillRef("https://github.com/owner/repo/blob/main/skills/foo/helper.py"),
    ).toThrow(/SKILL\.md/);
  });

  it("rejects path traversal in the sub-path", () => {
    expect(() => parseRemoteSkillRef("github/owner/repo#../../etc")).toThrow(/path/i);
  });

  it("returns null for a local path (not a remote ref)", () => {
    expect(parseRemoteSkillRef("./skills/my-skill")).toBeNull();
    expect(parseRemoteSkillRef("/abs/path/skill")).toBeNull();
    expect(parseRemoteSkillRef("plugins/polygraph/skills/polygraph")).toBeNull();
  });

  it("returns null for non-github URLs (unsupported hosts stay local errors)", () => {
    expect(parseRemoteSkillRef("https://gitlab.com/owner/repo")).toBeNull();
    expect(parseRemoteSkillRef("http://github.com/owner/repo")).toBeNull();
  });
});

describe("tarballUrl", () => {
  it("builds the codeload tarball URL for a ref", () => {
    expect(tarballUrl({ owner: "o", repo: "r", gitRef: "main" })).toBe(
      "https://codeload.github.com/o/r/tar.gz/main",
    );
  });

  it("URL-encodes ref names with slashes", () => {
    expect(tarballUrl({ owner: "o", repo: "r", gitRef: "feat/x" })).toBe(
      "https://codeload.github.com/o/r/tar.gz/feat%2Fx",
    );
  });
});
