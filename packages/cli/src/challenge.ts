/**
 * `polygraphso challenge <attestation-uid> <ref|https-url|path>` — re-run the
 * open harness against the graded server, pin the counter-evidence, and print
 * the `/challenge` hand-off (where a challenger posts the counter-stake).
 */

import { resolveTarget, pinBundle } from "./litmus.js";
import { apiBaseUrl } from "./api.js";

export async function runChallengeCli(args: readonly string[]): Promise<number> {
  const uid = args[0];
  const target = args[1];
  if (!uid || !target) {
    process.stderr.write("usage: polygraphso challenge <attestation-uid> <ref | https-url | path>\n");
    return 2;
  }

  const { runLitmus } = await import("@polygraph/probes");
  const bundle = await runLitmus(resolveTarget(target));
  process.stdout.write(`→ re-run grade: ${bundle.grade} · fingerprint ${shortFp(bundle.toolDefsFingerprint)}\n`);

  if (!process.env.POLYGRAPH_API_URL) {
    process.stdout.write("→ set POLYGRAPH_API_URL to pin counter-evidence and get the /challenge link\n");
    return 0;
  }

  try {
    const cid = await pinBundle(bundle);
    const url = new URL(`${apiBaseUrl()}/challenge`);
    url.searchParams.set("uid", uid);
    url.searchParams.set("cid", cid);
    process.stdout.write(`→ counter-evidence ${cid}\n→ challenge ${url.toString()}\n`);
    return 0;
  } catch (err) {
    process.stdout.write(`→ pin failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function shortFp(fp: string): string {
  return fp.length > 14 ? `${fp.slice(0, 6)}…${fp.slice(-4)}` : fp;
}
