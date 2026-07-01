import { describe, it, expect } from "vitest";
import { connectTarget, IsolationUnsupportedError } from "./index.js";

/**
 * isolation:"docker" is supported for npm AND pypi refs (both are containerized:
 * npm via `--ignore-scripts`, pypi via a wheels-only venv). Every other stdio kind
 * fails closed with IsolationUnsupportedError BEFORE any host execution (these
 * throws happen before Docker is touched, so they run without a daemon). http
 * targets are unaffected — isolation is stdio-only.
 */

describe("connectTarget — isolation:'docker' unsupported kinds (fail closed)", () => {
  it("throws IsolationUnsupportedError for an explicit stdio command", async () => {
    await expect(
      connectTarget({ command: "node", args: ["-e", "1"] }, { isolation: "docker" }),
    ).rejects.toBeInstanceOf(IsolationUnsupportedError);
  });

  it("throws IsolationUnsupportedError for a github ref, naming the kind", async () => {
    await expect(connectTarget("github/owner/repo", { isolation: "docker" })).rejects.toThrow(
      /github/,
    );
    await expect(connectTarget("github/owner/repo", { isolation: "docker" })).rejects.toBeInstanceOf(
      IsolationUnsupportedError,
    );
  });

  // npm and pypi are NOT rejected by the gate — they proceed to staging (which needs
  // Docker), so they are not asserted here (a synchronous reject would touch Docker).
  // The pypi-under-docker path is covered end-to-end by the Docker-gated live test in
  // `pypi-live.test.ts`.
});
