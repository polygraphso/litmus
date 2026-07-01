/**
 * Containerized stdio connect. When isolation is
 * requested, an npm target's code runs ONLY inside the hardened
 * `polygraph-egress-sniff:latest` image, reached over stdio through
 * `docker run -i`. This mirrors the egress-runner's target container minus the
 * sinkhole (C-02 captures egress on its own sinkholed run); here the network is
 * simply off (`--network none`).
 *
 * `containerLaunch` is a PURE arg builder so the exact flag set is unit-testable
 * — a silent weakening of any sandbox flag fails `container.test.ts`. The flags
 * are the audited C-02 hardening set (egress-runner.ts), carried verbatim.
 */

import { randomUUID } from "node:crypto";
import { docker, labelFlags } from "../docker/staging.js";

const IMAGE_TAG = "polygraph-egress-sniff:latest";

/** Thrown when isolation:"docker" is requested for a target kind it can't sandbox. */
export class IsolationUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationUnsupportedError";
  }
}

export interface ContainerLaunchOptions {
  /** Absolute path (inside /stage) of the package's launch script. */
  entry: string;
  /** The staging volume (mounted read-only at /stage). */
  stageVolume: string;
  /** The canary seed volume (mounted read-only at /work). */
  seedVolume: string;
  /** Canary env, one `-e KEY=VALUE` per entry — canaries travel INTO the
   *  container via -e, NOT via the docker CLI's own environment. */
  canaryEnv: Record<string, string>;
  /** Run label so a SIGKILLed parent can sweep this container. */
  runLabel?: string;
  /** Docker runtime override (production: `runsc`/gVisor). */
  runtime?: string;
  /** Interpreter the entry is launched with (`--entrypoint`). Defaults to `node`;
   *  a staged pypi package passes its venv python (`/stage/venv/bin/python`). */
  interpreter?: string;
}

/**
 * A docker token (volume name or entry path) that goes onto the `docker run`
 * command line must not contain whitespace and must not start with `-` (so it
 * can never be re-read as a flag). Defence in depth: staging already names
 * volumes safely and the entry comes from our offline resolver, but the values
 * cross a shell-less execFile boundary into docker's own arg parser.
 */
function assertSafeToken(value: string, what: string): void {
  if (/\s/.test(value)) throw new Error(`${what} must not contain whitespace: ${JSON.stringify(value)}`);
  if (value.startsWith("-")) throw new Error(`${what} must not start with "-": ${JSON.stringify(value)}`);
  if (value.length === 0) throw new Error(`${what} must not be empty`);
}

/**
 * Build the `docker run -i …` command line for the main connect. Pure.
 * `/work` is mounted READ-ONLY (canaries are read-only data; a writable
 * disk-backed volume is a host-disk-exhaustion primitive) and `/tmp` is a
 * size-capped tmpfs.
 */
export function containerLaunch(opts: ContainerLaunchOptions): { command: "docker"; args: string[] } {
  assertSafeToken(opts.stageVolume, "stage volume");
  assertSafeToken(opts.seedVolume, "seed volume");
  assertSafeToken(opts.entry, "entry");
  const interpreter = opts.interpreter ?? "node";
  assertSafeToken(interpreter, "interpreter");

  const envFlags = Object.entries(opts.canaryEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const runtimeFlags = opts.runtime ? ["--runtime", opts.runtime] : [];

  const args = [
    "run", "-i", "--rm", "--network", "none", "--user", "node", "--read-only",
    "-v", `${opts.stageVolume}:/stage:ro`,
    "-v", `${opts.seedVolume}:/work:ro`,
    "-w", "/work",
    "--tmpfs", "/tmp:rw,size=64m,mode=1777",
    "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256",
    "--memory", "512m", "--cpus", "1",
    "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
    "--sysctl", "net.ipv6.conf.default.disable_ipv6=1",
    ...labelFlags(opts.runLabel),
    ...envFlags,
    ...runtimeFlags,
    "--entrypoint", interpreter, IMAGE_TAG, opts.entry,
  ];

  return { command: "docker", args };
}

/**
 * Build the STABLE descriptor command string recorded in the evidence bundle for
 * the container path. Pure. The descriptor is NOT part of the fingerprint, so it
 * is safe to sanitize — and it MUST be, because the live `docker run` args carry
 * two per-run-nondeterministic, secret-shaped values that would otherwise land in
 * every published `hosted_runs.evidence`:
 *   - the canary `-e KEY=VALUE` pairs (synthetic per-run secrets) — dropped
 *     entirely (mirrors how the orchestration-only `--name` is already excluded);
 *   - the random `pg-stage-<uuid>` / `pg-seed-<uuid>` volume names — replaced with
 *     the stable placeholders `<stage>` / `<seed>` so the recorded command is
 *     deterministic across runs.
 * This changes ONLY the recorded string; the args actually passed to docker are
 * the real, unsanitized ones (`containerLaunch` output).
 */
export function recordedContainerCommand(
  command: string,
  args: readonly string[],
  vols: { stageVolume: string; seedVolume: string },
): string {
  const out: string[] = [command];
  for (let i = 0; i < args.length; i += 1) {
    // Drop the canary `-e KEY=VALUE` pair (flag + its value) — synthetic per-run
    // secrets that must never reach the stored descriptor.
    if (args[i] === "-e") {
      i += 1; // also skip the KEY=VALUE value
      continue;
    }
    out.push(stabilizeToken(args[i]!, vols));
  }
  return out.join(" ");
}

/** Replace a random volume name (bare or inside a `<vol>:/mount:ro` spec) with a stable placeholder. */
function stabilizeToken(token: string, vols: { stageVolume: string; seedVolume: string }): string {
  return token
    .replace(vols.stageVolume, "<stage>")
    .replace(vols.seedVolume, "<seed>");
}

export interface SeedVolume {
  /** The docker volume name (mount read-only at /work). */
  volume: string;
  /** Best-effort `docker volume rm -f`. Never throws. */
  cleanup(): Promise<void>;
}

export interface PrepareSeedVolumeOptions {
  runLabel?: string;
}

/**
 * Build a labeled docker volume and populate it from a host directory of canary
 * files, WITHOUT a host bind mount (so it works on any daemon, including a
 * macOS dev VM): create the volume, mount it into a no-op `--entrypoint true`
 * helper container, `docker cp <seedDir>/. <ctr>:/work`, then remove the helper.
 * The volume is later mounted read-only at /work.
 */
export async function prepareSeedVolume(seedDir: string, opts: PrepareSeedVolumeOptions = {}): Promise<SeedVolume> {
  const vol = `pg-seed-${randomUUID().slice(0, 8)}`;
  const cleanup = () => docker(["volume", "rm", "-f", vol]).then(() => {}).catch(() => {});
  await docker(["volume", "create", ...labelFlags(opts.runLabel), vol]);

  const helper = `pg-seedcp-${randomUUID().slice(0, 8)}`;
  try {
    try {
      await docker([
        "container", "create", "--name", helper,
        ...labelFlags(opts.runLabel),
        "--entrypoint", "true", "-v", `${vol}:/work`, IMAGE_TAG,
      ]);
      // Trailing `/.` copies the directory CONTENTS into /work (not the dir itself).
      await docker(["cp", `${seedDir}/.`, `${helper}:/work`]);
    } finally {
      // Remove the helper FIRST, in both the success and failure paths, so the
      // volume it mounts is no longer referenced — Docker refuses `volume rm`
      // (even `-f`, even for a Created container) while any container holds it.
      await docker(["rm", "-f", helper]).catch(() => {});
    }
  } catch (err) {
    // The helper is already gone (inner finally), so cleanup()'s `volume rm` can
    // succeed instead of failing silently on "volume is in use".
    await cleanup();
    throw err;
  }

  return { volume: vol, cleanup };
}
