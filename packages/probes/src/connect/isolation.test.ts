import { describe, it, expect } from "vitest";
import { connectTarget, IsolationUnsupportedError } from "./index.js";

/**
 * isolation:"docker" is supported for npm, pypi AND github refs (all containerized:
 * npm via `--ignore-scripts`, pypi via a wheels-only venv, github by cloning +
 * building the repo in the sandbox). Every other stdio kind fails closed with
 * IsolationUnsupportedError BEFORE any host execution (the throw happens before
 * Docker is touched, so it runs without a daemon). http targets are unaffected —
 * isolation is stdio-only.
 */

describe("connectTarget — isolation:'docker' unsupported kinds (fail closed)", () => {
  it("throws IsolationUnsupportedError for an explicit stdio command", async () => {
    await expect(
      connectTarget({ command: "node", args: ["-e", "1"] }, { isolation: "docker" }),
    ).rejects.toBeInstanceOf(IsolationUnsupportedError);
  });

  // npm, pypi and github are NOT rejected by the gate — they proceed to staging (which
  // needs Docker), so they are not asserted here (a synchronous reject would touch
  // Docker/network). Those paths are covered end-to-end by the Docker-gated live tests
  // (`container-live.test.ts`, `pypi-live.test.ts`, `github-live.test.ts`).
});
