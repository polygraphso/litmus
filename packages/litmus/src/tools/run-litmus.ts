/**
 * `run_litmus` — run the open behavioral harness end-to-end against an MCP
 * server and return the grade and the evidence. Brand-voiced: plain, exact, no
 * overclaim.
 *
 * Unlike `verify_attestation` (a passive onchain read), this tool LAUNCHES the
 * target server's code to exercise it — sandboxed for egress when Docker is
 * present. It needs no wallet or RPC.
 */

import { z } from "zod";
import { runLitmus } from "@polygraph/probes";
import { METHODOLOGY_VERSION, type EvidenceBundle } from "@polygraph/core";
import { resolveTarget } from "@polygraph/cli/litmus";

export const RUN_LITMUS_TOOL_NAME = "run_litmus";
export const RUN_LITMUS_TOOL_TITLE = "Run a behavioral litmus on an MCP server";
export const RUN_LITMUS_TOOL_DESCRIPTION = [
  `Run the open behavioral litmus (${METHODOLOGY_VERSION}) against an MCP server and return`,
  "its grade. The harness connects like an agent would, fingerprints the tool",
  "surface, and runs three probe categories: C-01 tool-output injection, C-02",
  "permission overreach (egress in a hardened default-deny Docker sandbox, plus a",
  "declared-permission honesty check), and C-03 sensitive-data handling (planted",
  "canaries). It grades A–F.",
  "",
  "This is ACTIVE: it launches the target server's code to exercise it (sandboxed",
  "for egress when Docker is available). It is not a passive lookup — for that,",
  "use `verify_attestation`. It needs no wallet or RPC.",
  "",
  "Input: server_ref — a registry ref (npm/@scope/server), an https:// MCP URL,",
  "or a local path to an MCP entry file. If Docker is unavailable, C-02 is",
  "skipped and the grade is capped at B for that run.",
].join("\n");

export const runLitmusInputShape = {
  server_ref: z
    .string()
    .min(1)
    .max(512)
    .describe("What to grade: a registry ref (npm/@scope/server), an https:// MCP URL, or a local path to an MCP entry file."),
};

export async function handleRunLitmus({ server_ref }: { server_ref: string }) {
  try {
    const bundle = await runLitmus(resolveTarget(server_ref));
    const payload = summarize(bundle);
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  } catch (err) {
    // An invalid/oversized/private-resolving target, a hostile (deeply-nested)
    // tool surface, or a connect timeout must surface as a clean tool error —
    // never an unhandled rejection in the host process.
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true as const, content: [{ type: "text" as const, text: `run_litmus failed: ${message}` }] };
  }
}

function summarize(b: EvidenceBundle) {
  const find = (code: string) => b.categories.find((c) => c.code === code);
  const categories = (["C-01", "C-02", "C-03"] as const).map((code) => {
    const c = find(code);
    const findings =
      c?.status === "fail"
        ? c.probes
            .flatMap((p) => p.findings)
            .filter((f) => f.severity === "high")
            .slice(0, 5)
            .map((f) => ({ tool: f.tool, kind: f.kind, match: truncate(f.match, 120), host: f.host, port: f.port }))
        : [];
    return { code, status: c?.status ?? "unknown", reason: c?.reason ?? null, findings };
  });

  const dockerSkipped = !b.harness.dockerAvailable || find("C-02")?.status === "skipped";

  return {
    grade: b.grade,
    gradeRationale: b.gradeRationale,
    fingerprint: b.toolDefsFingerprint,
    serverRef: b.serverRef,
    resolvedVersion: b.resolvedVersion,
    ranAt: b.ranAt,
    methodologyVersion: b.methodologyVersion,
    categories,
    ...(dockerSkipped
      ? { dockerSkipped: "C-02 (egress) was not run because Docker was unavailable; the grade is capped at B for this run." }
      : {}),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
