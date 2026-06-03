/**
 * `polygraphso check <ref>` — a sub-second lookup over published grades. Reads
 * the latest attestation from the discovery API; falls back to "not available"
 * when there's none (or the API is unreachable). Zero harness import.
 */

import { attestationsUrl } from "./api.js";

interface AttestationRow {
  attestation_uid?: string;
  grade?: string;
  network?: string;
  report_cid?: string;
}

export async function runCheck(args: readonly string[]): Promise<number> {
  const ref = args[0];
  if (!ref) {
    process.stderr.write("usage: polygraphso check <registry-ref>\n");
    return 2;
  }

  try {
    const res = await fetch(`${attestationsUrl()}?ref=${encodeURIComponent(ref)}`);
    if (res.ok) {
      const row = (await res.json()) as AttestationRow | null;
      if (row?.attestation_uid) {
        process.stdout.write(
          [`→ ${ref}`, `→ polygraph: ${row.grade ?? "?"} · ${easscan(row.network, row.attestation_uid)}`, ""].join("\n"),
        );
        return 0;
      }
    }
  } catch {
    /* fall through to the not-available message */
  }

  process.stdout.write(
    [
      `→ ${ref}`,
      "→ polygraph: not yet available",
      `→ run a behavioral litmus: polygraphso litmus ${ref}`,
      "",
    ].join("\n"),
  );
  return 0;
}

function easscan(network: string | undefined, uid: string): string {
  const host = network === "base" ? "base.easscan.org" : "base-sepolia.easscan.org";
  return `https://${host}/attestation/view/${uid}`;
}
