/**
 * Container staging for the egress sandbox (technical-design §4), extracted from
 * `egress-runner.ts` so both C-02 and the (hosted-service) containerized stdio
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
// package's package.json under /stage and print `{entry, version}` as JSON so a
// single container run yields both. argv[1] = pkgName.
//   - entry: absolute path to the launch script from `bin` (string bin, or the
//     first value of an object bin); null when there is no bin.
//   - version: package.json `version`; null when unreadable.
// This is the bin-resolution logic of the old BIN_RESOLVER, extended to also
// surface the resolved version (NEW) without a second container run.
export const RESOLVER_SCRIPT =
  'const p=require("path");const d="/stage/node_modules/"+process.argv[1];' +
  "let j;try{j=require(d+'/package.json')}catch{}" +
  "let entry=null;if(j){const b=j.bin;const r=typeof b===\"string\"?b:(b&&Object.values(b)[0]);if(r)entry=p.join(d,r);}" +
  "const version=j&&j.version?j.version:null;" +
  "process.stdout.write(JSON.stringify({entry,version}));";

export interface StagedPackage {
  /** The staging volume name (mount read-only into the sandboxed run). */
  volume: string;
  /** Absolute path to the package's launch script inside /stage. */
  entry: string;
  /** The package's resolved version, or null when unreadable. */
  resolvedVersion: string | null;
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

/** Parse the resolver's `{entry, version}` JSON. Pure; nulls on empty/malformed. */
export function parseResolverOutput(output: string): { entry: string | null; version: string | null } {
  try {
    const rec = JSON.parse(output) as { entry?: unknown; version?: unknown };
    return {
      entry: typeof rec.entry === "string" ? rec.entry : null,
      version: typeof rec.version === "string" ? rec.version : null,
    };
  } catch {
    return { entry: null, version: null };
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

    // Resolve the package's launch script + version (offline, non-root, our code).
    const resolved = parseResolverOutput((await docker(resolverRunArgs(vol, image, pkgName, opts.runLabel, runtime))).trim());
    // No bin (or its entry file was never built because we skip install scripts) →
    // can't launch under sandbox policy. Degrade rather than re-run install WITH scripts.
    if (!resolved.entry) {
      await cleanup();
      throw new Error(
        `target package ${pkgName} exposes no launchable bin under the sandbox policy (install scripts are skipped)`,
      );
    }
    return { volume: vol, entry: resolved.entry, resolvedVersion: resolved.version, cleanup };
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
