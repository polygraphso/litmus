/**
 * Container staging for the egress sandbox (technical-design §4), extracted from
 * `egress-runner.ts` so both C-02 and the hosted service's containerized stdio
 * connect path can share one copy of the mechanics.
 *
 * Staging means: build the hardened `polygraph-egress-sniff:latest` image, create
 * a randomly-named volume, install the target into it WITH network on but
 * `--ignore-scripts` (so npm runs but the package's own code never does), then
 * resolve the package's launch script + version offline in a non-root container.
 * The sandboxed run that follows needs no internet.
 *
 * `runLabel`: when set, EVERY docker resource created here carries
 * `--label polygraph-litmus-run=<runLabel>`. A SIGKILLed parent must be able to
 * find and remove the volume and any leftover helper containers by label (the
 * hosted runner's resource-leak defence; security review §4).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import * as path from "node:path";

const IMAGE_TAG = "polygraph-egress-sniff:latest";
const LABEL_KEY = "polygraph-litmus-run";

// The Docker assets (Dockerfile + sinkhole) live alongside the source under
// `packages/probes/docker` when run via tsx, but get copied next to the bundled
// output as `dist/docker` when this module is inlined into the published
// `@polygraphso/litmus` package. Probe both layouts and use the first that holds
// the Dockerfile, so the same source works in dev and in the published bundle.
const DOCKER_DIR = resolveDockerDir();

function resolveDockerDir(): string {
  const candidates = ["../../docker", "./docker", "../docker"];
  for (const rel of candidates) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(path.join(dir, "egress-sniff.Dockerfile"))) return dir;
  }
  // Fall back to the dev layout; callers report `ran:false` if it's wrong.
  return fileURLToPath(new URL("../../docker", import.meta.url));
}

// Runs in the staged container (offline, non-root, OUR code): read the target
// package's package.json under /stage and print `{bins, version, declaredEgress}`
// as JSON so a single container run yields all three. argv[1] = pkgName.
//   - bins: { binName: absolutePath } for EVERY declared bin (so the launcher can
//     probe each and pick the one that speaks MCP). A string `bin` is keyed by the
//     package's unscoped name; an object `bin` keeps its own names. Empty when none.
//   - version: package.json `version`; null when unreadable.
//   - declaredEgress: the package's `polygraph.egress` host-pattern array (C-02
//     declared egress, litmus-v3); [] when absent/malformed.
export const RESOLVER_SCRIPT =
  'const p=require("path");const n=process.argv[1];const d="/stage/node_modules/"+n;' +
  "let j;try{j=require(d+'/package.json')}catch{}" +
  "let bins={};if(j){const b=j.bin;" +
  'if(typeof b==="string"){bins[n.replace(/^@[^/]+\\//,"")]=p.join(d,b);}' +
  "else if(b){for(const k in b){bins[k]=p.join(d,b[k]);}}}" +
  "const version=j&&j.version?j.version:null;" +
  'let declaredEgress=[];if(j&&j.polygraph&&Array.isArray(j.polygraph.egress)){' +
  'declaredEgress=j.polygraph.egress.filter(function(x){return typeof x==="string"});}' +
  "process.stdout.write(JSON.stringify({bins,version,declaredEgress}));";

// ── pypi staging ─────────────────────────────────────────────────────────────
// A capability addition, not a methodology change: a pypi server is graded by the
// SAME rubric as npm, so METHODOLOGY_VERSION is unchanged (litmus-v10).

/** The interpreter a staged pypi package is launched with: the venv's python,
 *  which (built on the system python3) symlinks to a world-executable interpreter
 *  the non-root `node` run user can exec from the read-only /stage mount. */
export const PYPI_VENV_PYTHON = "/stage/venv/bin/python";

// Python analog of RESOLVER_SCRIPT: run by /stage/venv/bin/python (offline,
// non-root, OUR code) to read the installed dist's `{bins, version, declaredEgress}`
// and print them as the SAME JSON shape parseResolverOutput already parses.
//   - bins: { consoleScriptName: /stage/venv/bin/<name> } for every console_scripts
//     entry point, so the launcher can probe each (mcp-named first). Empty when none.
//   - declaredEgress: the host patterns a server declares via a custom entry-point
//     group `polygraph.egress` (the patterns are the entry-point NAMES). Unlike
//     pyproject's `[tool.polygraph]`, entry points ship INSIDE the wheel, so they are
//     readable offline from the staged venv. Authors add, in pyproject.toml:
//       [project.entry-points."polygraph.egress"]
//       "api.example.com" = "x"
//   - version: the dist version; null when unreadable.
export const PYPI_RESOLVER_SCRIPT =
  "import importlib.metadata as m,os,sys,json\n" +
  "n=sys.argv[1]\n" +
  "try:\n" +
  " d=m.distribution(n);b=os.path.dirname(sys.executable)\n" +
  " bins={ep.name:os.path.join(b,ep.name) for ep in d.entry_points if ep.group=='console_scripts'}\n" +
  " eg=[ep.name for ep in d.entry_points if ep.group=='polygraph.egress']\n" +
  " v=d.version\n" +
  "except Exception:\n" +
  " bins={};eg=[];v=None\n" +
  "print(json.dumps({'bins':bins,'version':v,'declaredEgress':eg}))";

export interface StagedPackage {
  /** The staging volume name (mount read-only into the sandboxed run). */
  volume: string;
  /** Every declared bin: { binName: absolutePath inside /stage }. The launcher
   *  probes these (mcp-named first) to find the one that speaks MCP. */
  bins: Record<string, string>;
  /** The package's resolved version, or null when unreadable. */
  resolvedVersion: string | null;
  /** The package's declared egress host patterns (`polygraph.egress`); [] when none. */
  declaredEgress: string[];
  /** The interpreter to launch the entry with (`--entrypoint`): the venv python
   *  for a pypi package, undefined for npm (the launcher defaults to `node`). */
  interpreter?: string;
  /** Best-effort `docker volume rm -f`. Never throws. */
  cleanup(): Promise<void>;
}

export interface StageOptions {
  /** Label every docker resource created here, so a killed parent can sweep. */
  runLabel?: string;
  /**
   * Docker runtime override (production: `runsc`/gVisor). Applied to the install
   * and resolver containers so the steps that fetch/extract and read the
   * attacker-controlled package tree share the SAME kernel-isolation boundary as
   * the run step — not the weaker default runc. Defaults to
   * `process.env.LITMUS_DOCKER_RUNTIME` when unset (see stageInto).
   */
  runtime?: string;
}

/** Build `--label polygraph-litmus-run=<runLabel>` (or nothing). Pure. */
export function labelFlags(runLabel: string | undefined): string[] {
  return runLabel ? ["--label", `${LABEL_KEY}=${runLabel}`] : [];
}

/** `docker volume create [--label …] <vol>`. Pure. */
export function volumeCreateArgs(vol: string, runLabel: string | undefined): string[] {
  return ["volume", "create", ...labelFlags(runLabel), vol];
}

/**
 * Hardened, `--ignore-scripts` npm install of `spec` (a pkgSpec or a /stage
 * tarball path) into the volume, network ON. Pure.
 *
 * SECURITY: --ignore-scripts skips the package's install/postinstall hooks, so
 * NO code from the (possibly hostile) package runs here despite network being on —
 * only npm itself executes. The run stays root (it must write the root-owned
 * volume) but with caps dropped + no-new-privileges + limits.
 */
export function stageInstallArgs(
  vol: string,
  image: string,
  spec: string,
  runLabel: string | undefined,
  runtime?: string,
): string[] {
  return [
    "run", "--rm", "-v", `${vol}:/stage`,
    ...labelFlags(runLabel),
    // gVisor parity: this container fetches + extracts the attacker's package and
    // its full dependency tree (network on, as root), so it must run under the same
    // runtime as the sandboxed run, not the default runc.
    ...(runtime ? ["--runtime", runtime] : []),
    "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "1g",
    "--entrypoint", "npm", image,
    // `--` ends npm option parsing so a spec can never be read as a flag
    // (defence-in-depth; parseServerRef already rejects "-"-leading segments).
    "install", "--prefix", "/stage", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "error", "--", spec,
  ];
}

/**
 * Resolve the package's launch script + version offline, non-root, our code. Pure.
 *
 * `--network none`: the resolver only reads /stage (our RESOLVER_SCRIPT requires
 * the package.json that staging already installed); it needs no network, so deny
 * it outright. `--pids-limit`/`--memory` bound it like the egress target so a
 * pathological package.json (require-loop, huge tree) can't fork-bomb or OOM the
 * host. The install container, by contrast, keeps its network ON (it must fetch).
 */
export function resolverRunArgs(
  vol: string,
  image: string,
  pkgName: string,
  runLabel: string | undefined,
  runtime?: string,
): string[] {
  return [
    "run", "--rm", "-v", `${vol}:/stage`, "--user", "node", "--network", "none",
    ...labelFlags(runLabel),
    // gVisor parity: reads the attacker-controlled package.json — same runtime as the run step.
    ...(runtime ? ["--runtime", runtime] : []),
    "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "512m",
    "--entrypoint", "node", image, "-e", RESOLVER_SCRIPT, pkgName,
  ];
}

/**
 * Hardened, WHEELS-ONLY install of a pypi `spec` into a venv under /stage, network
 * ON. Pure.
 *
 * SECURITY: `--only-binary=:all:` forces wheels, so NO PEP 517 build backend /
 * setup.py runs (the pypi analog of npm's `--ignore-scripts` — there is no
 * `--ignore-scripts` for build hooks, so wheels-only is how we keep target code
 * from executing during staging). A package with no wheel FAILS the install rather
 * than building from sdist — fail closed, never run the target's build code. `uv
 * venv --python python3` builds on the SYSTEM interpreter so the venv's bin/python
 * is a world-executable symlink the non-root run user can exec from the RO mount.
 * The spec rides as `sh`'s positional `$1` after `--`, so it can never be read as a
 * flag (defence-in-depth; parseServerRef already rejects "-"-leading segments). Runs
 * as root (it must write the root-owned volume) but caps-dropped + no-new-privileges.
 */
export function stagePypiInstallArgs(
  vol: string,
  image: string,
  spec: string,
  runLabel: string | undefined,
  runtime?: string,
): string[] {
  const script =
    "uv venv /stage/venv --python python3 && " +
    'uv pip install --python /stage/venv/bin/python --only-binary=:all: -- "$1"';
  return [
    "run", "--rm", "-v", `${vol}:/stage`,
    ...labelFlags(runLabel),
    // gVisor parity: fetches + extracts the attacker's wheel tree (network on), so
    // it runs under the same runtime as the sandboxed run, not the default runc.
    ...(runtime ? ["--runtime", runtime] : []),
    "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "1g",
    "--entrypoint", "sh", image,
    // `sh -c <script> sh <spec>`: spec is $1 (quoted in the script), never a flag.
    "-c", script, "sh", spec,
  ];
}

/**
 * Resolve the staged pypi dist's console-script entry + version + declared egress
 * offline, non-root, our code. Pure. `--network none`: the resolver only reads the
 * staged venv via importlib.metadata (run by the venv's python), so deny network
 * outright; `--pids-limit`/`--memory` bound it like the egress target.
 */
export function pypiResolverRunArgs(
  vol: string,
  image: string,
  pkgName: string,
  runLabel: string | undefined,
  runtime?: string,
): string[] {
  return [
    "run", "--rm", "-v", `${vol}:/stage`, "--user", "node", "--network", "none",
    ...labelFlags(runLabel),
    // gVisor parity: reads the attacker-controlled venv metadata — same runtime as the run step.
    ...(runtime ? ["--runtime", runtime] : []),
    "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "512m",
    "--entrypoint", PYPI_VENV_PYTHON, image, "-c", PYPI_RESOLVER_SCRIPT, pkgName,
  ];
}

/**
 * No-op helper container with the volume mounted at /stage, so a tarball can be
 * `docker cp`'d into the volume before staging. Pure. (Test-support path.)
 */
export function tarballCopyContainerArgs(name: string, vol: string, image: string, runLabel: string | undefined): string[] {
  return [
    "container", "create", "--name", name,
    ...labelFlags(runLabel),
    "--entrypoint", "true", "-v", `${vol}:/stage`, image,
  ];
}

/** Parse the resolver's `{bins, version, declaredEgress}` JSON. Pure; empty bins/
 *  egress + null version on empty/malformed. Non-string bin paths / egress entries
 *  are dropped. */
export function parseResolverOutput(
  output: string,
): { bins: Record<string, string>; version: string | null; declaredEgress: string[] } {
  try {
    const rec = JSON.parse(output) as { bins?: unknown; version?: unknown; declaredEgress?: unknown };
    const bins: Record<string, string> = {};
    if (rec.bins && typeof rec.bins === "object" && !Array.isArray(rec.bins)) {
      for (const [k, v] of Object.entries(rec.bins as Record<string, unknown>)) {
        if (typeof v === "string") bins[k] = v;
      }
    }
    const declaredEgress = Array.isArray(rec.declaredEgress)
      ? (rec.declaredEgress as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    return { bins, version: typeof rec.version === "string" ? rec.version : null, declaredEgress };
  } catch {
    return { bins: {}, version: null, declaredEgress: [] };
  }
}

/** `docker build [--pull] -t <tag> -f <Dockerfile> <dir>`. Pure. */
function buildImageArgs(pull: boolean): string[] {
  return [
    "build",
    ...(pull ? ["--pull"] : []),
    "-t",
    IMAGE_TAG,
    "-f",
    path.join(DOCKER_DIR, "egress-sniff.Dockerfile"),
    DOCKER_DIR,
  ];
}

/**
 * Build the hardened sandbox image from the probed Docker dir. `--pull` refreshes
 * the `node:22-slim` base on each (infrequent) rebuild so a long-lived runner VM
 * doesn't pin a stale, unpatched base image.
 *
 * Resilience: `--pull` reaches Docker Hub, so a registry outage fails the build
 * even when a cached base would suffice. Retry ONCE without `--pull` (cached
 * base) before giving up — the security posture is unchanged (the cached base is
 * the one we last pulled; we lose only the freshness refresh until the registry
 * recovers). `docker` is injectable so the seam test drives both paths.
 *
 * `LITMUS_DOCKER_BUILD_PULL=0` skips the per-build pull entirely and builds against
 * the cached base — for a long-lived runner that refreshes `node:22-slim` out of
 * band (a daily cron), so steady-state grading makes NO Docker Hub call and never
 * trips the anonymous pull rate limit. Default (unset) keeps the pull-then-fallback
 * behavior, so the published harness and CI stay fresh.
 */
export async function ensureImage(dockerFn: typeof docker = docker): Promise<void> {
  if (process.env.LITMUS_DOCKER_BUILD_PULL === "0") {
    await dockerFn(buildImageArgs(false), 180_000);
    return;
  }
  try {
    await dockerFn(buildImageArgs(true), 180_000);
  } catch {
    process.stderr.write("docker build --pull failed; retrying with cached base image\n");
    await dockerFn(buildImageArgs(false), 180_000);
  }
}

async function stageInto(vol: string, image: string, spec: string, pkgName: string, opts: StageOptions): Promise<StagedPackage> {
  const cleanup = () => docker(["volume", "rm", "-f", vol]).then(() => {}).catch(() => {});
  // Default the runtime from the env every other container path reads, so the
  // existing callers (connect, egress) get gVisor parity with no signature change.
  const runtime = opts.runtime ?? process.env.LITMUS_DOCKER_RUNTIME;
  try {
    // Prep (network ON): install the target + its full dependency tree into the
    // volume so the sandboxed run needs no internet. Exits when done.
    await docker(stageInstallArgs(vol, image, spec, opts.runLabel, runtime), 180_000);

    // Resolve the package's bins + version (offline, non-root, our code).
    const resolved = parseResolverOutput((await docker(resolverRunArgs(vol, image, pkgName, opts.runLabel, runtime))).trim());
    // No bins (or their entry files were never built because we skip install
    // scripts) → can't launch under sandbox policy. Degrade rather than re-run
    // install WITH scripts.
    if (Object.keys(resolved.bins).length === 0) {
      await cleanup();
      throw new Error(
        `target package ${pkgName} exposes no launchable bin under the sandbox policy (install scripts are skipped)`,
      );
    }
    return { volume: vol, bins: resolved.bins, resolvedVersion: resolved.version, declaredEgress: resolved.declaredEgress, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Stage an npm package: create a labeled volume, install it offline-ready, and
 * resolve its launch script + version. Throws ("exposes no launchable bin …")
 * when there is no bin. `cleanup()` removes the volume best-effort.
 */
export async function stageNpmPackage(pkgSpec: string, opts: StageOptions = {}): Promise<StagedPackage> {
  const vol = `pg-stage-${randomUUID().slice(0, 8)}`;
  await docker(volumeCreateArgs(vol, opts.runLabel));
  // pkgName for the resolver: strip a trailing @version (but not a scope's leading @).
  const at = pkgSpec.lastIndexOf("@");
  const pkgName = at > 0 ? pkgSpec.slice(0, at) : pkgSpec;
  return stageInto(vol, IMAGE_TAG, pkgSpec, pkgName, opts);
}

/** pypi sibling of stageInto: wheels-only install + offline metadata resolve.
 *  Same degrade-rather-than-rerun policy and the same "exposes no launchable bin"
 *  sentinel string (callers match on it), so it threads the egress-runner's
 *  no-bin handling unchanged. */
async function stagePypiInto(vol: string, image: string, spec: string, pkgName: string, opts: StageOptions): Promise<StagedPackage> {
  const cleanup = () => docker(["volume", "rm", "-f", vol]).then(() => {}).catch(() => {});
  const runtime = opts.runtime ?? process.env.LITMUS_DOCKER_RUNTIME;
  try {
    // Prep (network ON): wheels-only install of the target + deps into a venv under
    // /stage so the sandboxed run needs no internet and no build code ever ran.
    await docker(stagePypiInstallArgs(vol, image, spec, opts.runLabel, runtime), 180_000);

    // Resolve the console-script entry + version + declared egress (offline, our code).
    const resolved = parseResolverOutput((await docker(pypiResolverRunArgs(vol, image, pkgName, opts.runLabel, runtime))).trim());
    if (Object.keys(resolved.bins).length === 0) {
      await cleanup();
      throw new Error(
        `target package ${pkgName} exposes no launchable bin under the sandbox policy (no console_scripts in the wheels-only install)`,
      );
    }
    return {
      volume: vol,
      bins: resolved.bins,
      resolvedVersion: resolved.version,
      declaredEgress: resolved.declaredEgress,
      interpreter: PYPI_VENV_PYTHON,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Stage a pypi package: create a labeled volume, wheels-only install it into a
 * venv offline-ready, and resolve its console-script + version + declared egress.
 * Throws ("exposes no launchable bin …") when there is no console script.
 * `cleanup()` removes the volume best-effort. `interpreter` on the result is the
 * venv python the launcher runs the entry with.
 */
export async function stagePypiPackage(name: string, version: string | null | undefined, opts: StageOptions = {}): Promise<StagedPackage> {
  const vol = `pg-stage-${randomUUID().slice(0, 8)}`;
  await docker(volumeCreateArgs(vol, opts.runLabel));
  // pip pins with `==`, not npm's `@`. pkgName (for the resolver) is the bare name.
  const spec = version ? `${name}==${version}` : name;
  return stagePypiInto(vol, IMAGE_TAG, spec, name, opts);
}

/**
 * Test-support path: stage a local tarball by copying it into the volume (no host
 * bind mount), then installing the in-volume tarball path with the same hardened
 * `--ignore-scripts` install. Shares all helpers with stageNpmPackage.
 */
export async function stageFromTarball(tarballPath: string, pkgName: string, opts: StageOptions = {}): Promise<StagedPackage> {
  const vol = `pg-stage-${randomUUID().slice(0, 8)}`;
  await docker(volumeCreateArgs(vol, opts.runLabel));
  // Copy the tarball into the volume via a no-op helper container + docker cp.
  const helper = `pg-cp-${randomUUID().slice(0, 8)}`;
  const tarName = path.basename(tarballPath);
  try {
    try {
      await docker(tarballCopyContainerArgs(helper, vol, IMAGE_TAG, opts.runLabel));
      await docker(["cp", tarballPath, `${helper}:/stage/${tarName}`]);
    } finally {
      // Remove the helper FIRST, in both the success and failure paths, so the
      // volume it mounts is no longer referenced — Docker refuses `volume rm`
      // (even `-f`, even for a Created container) while any container holds it.
      await docker(["rm", "-f", helper]).catch(() => {});
    }
  } catch (err) {
    // The cp choreography failed AFTER `volume create` — remove the now-orphaned
    // volume so it doesn't leak until the label sweep / daily prune. The helper is
    // already gone (the inner finally above), so this `volume rm` can succeed.
    // stageInto owns volume removal once reached.
    await docker(["volume", "rm", "-f", vol]).catch(() => {});
    throw err;
  }
  return stageInto(vol, IMAGE_TAG, `/stage/${tarName}`, pkgName, opts);
}

/** Shared execFile wrapper. Rejects with the docker subcommand + stderr on failure. */
export function docker(args: string[], timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args[0]} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}
