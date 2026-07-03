/**
 * Remote skill refs for the skill litmus: fetch a public GitHub skill directory
 * and grade it locally. The scan itself stays a pure static read — this module
 * only materializes the bytes (one TLS download from codeload.github.com), so
 * "no execution" still holds for the skill's own code.
 *
 * Accepted remote forms (public repos):
 *   https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md
 *   https://github.com/<owner>/<repo>/tree/<ref>/<path>
 *   https://github.com/<owner>/<repo>
 *   github/<owner>/<repo>#<path>          (default branch)
 *   github/<owner>/<repo>                 (default branch, repo root)
 *
 * Anything else (local paths, other hosts) is not a remote ref — callers fall
 * through to the local-directory path. The graded identity (`skillRef`) is the
 * versionless canonical `github/<owner>/<repo>#<path>` form used by published
 * skill grades; the content hash pins the exact bytes.
 */

import { createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface RemoteSkillRef {
  owner: string;
  repo: string;
  /** Git ref to download — a branch/tag/sha, or "HEAD" for the default branch. */
  gitRef: string;
  /** Skill directory inside the repo ("" = repo root), POSIX-normalized. */
  subPath: string;
  /** Versionless identity recorded on the evidence bundle. */
  canonicalRef: string;
}

/** Tarball download cap — a skill repo has no business being bigger. */
const MAX_TARBALL_BYTES = 256 * 1024 * 1024;

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

function canonical(owner: string, repo: string, subPath: string): string {
  return subPath ? `github/${owner}/${repo}#${subPath}` : `github/${owner}/${repo}`;
}

/** Normalize + traversal-guard a repo sub-path. Throws on `..`/absolute. */
function cleanSubPath(raw: string): string {
  const p = posix.normalize(raw.replace(/^\/+|\/+$/g, ""));
  if (p === "." || p === "") return "";
  if (p.startsWith("..") || posix.isAbsolute(p)) {
    throw new Error(`invalid skill path inside the repo: ${raw}`);
  }
  return p;
}

/**
 * Parse a remote skill ref. Returns null when `ref` is not a recognized remote
 * form (treat it as a local path). Throws with a user-facing message when it IS
 * a github form but malformed (wrong file, path traversal).
 */
export function parseRemoteSkillRef(ref: string): RemoteSkillRef | null {
  const trimmed = ref.trim();

  // github/<owner>/<repo>[#<path>] — the identity form used by published grades.
  const short = /^github\/([^/#\s]+)\/([^/#\s]+?)(?:\.git)?(?:#(.*))?$/.exec(trimmed);
  if (short) {
    const owner = short[1] ?? "";
    const repo = short[2] ?? "";
    if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
    const subPath = cleanSubPath(short[3] ?? "");
    return { owner, repo, gitRef: "HEAD", subPath, canonicalRef: canonical(owner, repo, subPath) };
  }

  // https://github.com/… URL forms. Other hosts / plain http are not remote refs.
  if (!trimmed.startsWith("https://github.com/")) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, "");
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;

  // Bare repo URL → root at the default branch.
  if (segments.length === 2) {
    return { owner, repo, gitRef: "HEAD", subPath: "", canonicalRef: canonical(owner, repo, "") };
  }

  const kind = segments[2];
  if (kind !== "blob" && kind !== "tree") return null;
  if (segments.length < 4) return null;
  // First segment after blob/tree is the ref. A branch name containing `/`
  // can't be disambiguated from the path without the GitHub API — the common
  // main/master/tag/sha case is what we support.
  const gitRef = decodeURIComponent(segments[3]!);
  let rest = segments.slice(4).map(decodeURIComponent).join("/");

  if (kind === "blob") {
    // A blob URL is a file: accept only SKILL.md and grade its directory.
    if (posix.basename(rest) !== "SKILL.md") {
      throw new Error(
        `a github blob URL must point at the skill's SKILL.md (got ${rest || "the repo root"}) — or pass the skill folder's tree URL`,
      );
    }
    rest = posix.dirname(rest);
    if (rest === ".") rest = "";
  }

  const subPath = cleanSubPath(rest);
  return { owner, repo, gitRef, subPath, canonicalRef: canonical(owner, repo, subPath) };
}

export function tarballUrl(ref: Pick<RemoteSkillRef, "owner" | "repo" | "gitRef">): string {
  return `https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz/${encodeURIComponent(ref.gitRef)}`;
}

export interface ResolvedSkillDir {
  /** Local directory to scan. */
  dir: string;
  /** Identity to record on the bundle (canonical remote ref, or the local path). */
  skillRef: string;
  /** Remove any temp files; safe to call always. */
  cleanup: () => void;
}

/** Download the repo tarball and extract it; returns the skill subdirectory. */
export async function fetchRemoteSkill(ref: RemoteSkillRef): Promise<ResolvedSkillDir> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "polygraph-skill-"));
  const cleanup = () => rmSync(tmpRoot, { recursive: true, force: true });
  try {
    const url = tarballUrl(ref);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      const hint =
        res.status === 404
          ? " (repo not found, private, or no such ref — only public repos are supported)"
          : "";
      throw new Error(`could not download ${ref.canonicalRef}: HTTP ${res.status}${hint}`);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_TARBALL_BYTES) {
      throw new Error(`repo tarball is too large to fetch (${declared} bytes)`);
    }

    const tarPath = join(tmpRoot, "repo.tar.gz");
    let received = 0;
    const counter = async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        received += chunk.byteLength;
        if (received > MAX_TARBALL_BYTES) {
          throw new Error("repo tarball is too large to fetch");
        }
        yield chunk;
      }
    };
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      counter,
      createWriteStream(tarPath),
    );

    // GitHub tarballs wrap everything in `<repo>-<ref>/` — strip it. System tar
    // is present on Linux, macOS, and Windows 10+.
    const extractDir = join(tmpRoot, "repo");
    await mkdir(extractDir);
    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", ["-xzf", tarPath, "-C", extractDir, "--strip-components=1"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      tar.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      tar.on("error", (err) => reject(new Error(`could not extract the repo tarball (${err.message})`)));
      tar.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`could not extract the repo tarball (tar exited ${code}: ${stderr.trim().slice(0, 200)})`)),
      );
    });

    const dir = ref.subPath ? join(extractDir, ...ref.subPath.split("/")) : extractDir;
    let st;
    try {
      st = statSync(dir);
    } catch {
      throw new Error(`no such directory in ${ref.owner}/${ref.repo}@${ref.gitRef}: ${ref.subPath || "/"}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`not a directory in the repo: ${ref.subPath} (pass the skill folder that contains SKILL.md)`);
    }
    try {
      statSync(join(dir, "SKILL.md"));
    } catch {
      throw new Error(`${ref.canonicalRef} has no SKILL.md — pass the skill folder that contains it`);
    }

    return { dir, skillRef: ref.canonicalRef, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Resolve a skill_ref to a local directory to scan: remote github refs are
 * downloaded to a temp dir; anything else must be an existing local directory.
 * Callers MUST call `cleanup()` when done (a no-op for local paths).
 */
export async function resolveSkillDir(skillRef: string): Promise<ResolvedSkillDir> {
  const remote = parseRemoteSkillRef(skillRef);
  if (remote) return fetchRemoteSkill(remote);

  let st;
  try {
    st = statSync(skillRef);
  } catch {
    throw new Error(
      `no such path: ${skillRef} (pass a local skill directory, a github.com skill URL, or github/<owner>/<repo>#<path>)`,
    );
  }
  if (!st.isDirectory()) {
    throw new Error(`not a directory: ${skillRef} (pass the skill folder that contains SKILL.md)`);
  }
  return { dir: skillRef, skillRef, cleanup: () => {} };
}
