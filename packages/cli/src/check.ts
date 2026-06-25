/**
 * `polygraphso check <ref[@version]>` — a sub-second lookup over published grades.
 * Reads the latest attestation from the discovery API; a version-pinned ref looks
 * up that exact version, a bare ref the latest graded version. Falls back to "not
 * available" when there's none (or the API is unreachable). Zero harness import
 * (only the lightweight identity helpers from @polygraph/core).
 */

import type { LitmusGrade } from "@polygraph/core";
import { parseServerRef, serverKey } from "@polygraph/core";
import { attestationsUrl } from "./api.js";

interface AttestationRow {
  attestation_uid?: string;
  grade?: string;
  network?: string;
  report_cid?: string;
  resolved_version?: string | null;
}

/** Split a raw target into the versionless lookup key and the pinned version
 *  (npm scopes must survive the @-version split). A non-registry target (URL /
 *  local path) has no version and is passed through verbatim. */
export function checkQuery(rawRef: string): { ref: string; ver: string | null } {
  try {
    const parsed = parseServerRef(rawRef);
    return { ref: serverKey(parsed), ver: parsed.version };
  } catch {
    return { ref: rawRef, ver: null };
  }
}

export interface PublishedGrade {
  grade: LitmusGrade;
  resolvedVersion: string | null;
  attestationUid: string;
  network?: string;
}

const VALID_GRADES: ReadonlySet<string> = new Set(["A", "B", "C", "D", "F"]);

/** Structured published-grade lookup. Returns null when there is no published
 *  grade, the API is unreachable, or the grade isn't a valid A–F letter. */
export async function lookupPublishedGrade(rawRef: string): Promise<PublishedGrade | null> {
  const { ref, ver } = checkQuery(rawRef);
  try {
    const query = `?ref=${encodeURIComponent(ref)}${ver ? `&ver=${encodeURIComponent(ver)}` : ""}`;
    const res = await fetch(`${attestationsUrl()}${query}`);
    if (!res.ok) return null;
    const row = (await res.json()) as AttestationRow | null;
    if (!row?.attestation_uid || !row.grade || !VALID_GRADES.has(row.grade)) return null;
    return {
      grade: row.grade as LitmusGrade,
      resolvedVersion: row.resolved_version ?? null,
      attestationUid: row.attestation_uid,
      network: row.network,
    };
  } catch {
    return null;
  }
}

export async function runCheck(args: readonly string[]): Promise<number> {
  const rawRef = args[0];
  if (!rawRef) {
    process.stderr.write("usage: polygraphso check <registry-ref[@version]>\n");
    return 2;
  }
  const row = await lookupPublishedGrade(rawRef);
  if (row) {
    const version = row.resolvedVersion ? ` · version ${row.resolvedVersion}` : "";
    process.stdout.write(
      [`→ ${rawRef}`, `→ polygraph: ${row.grade}${version} · ${easscan(row.network, row.attestationUid)}`, ""].join("\n"),
    );
    return 0;
  }
  process.stdout.write(
    [
      `→ ${rawRef}`,
      "→ polygraph: not yet available",
      `→ run a behavioral litmus: polygraphso litmus ${rawRef}`,
      "",
    ].join("\n"),
  );
  return 0;
}

function easscan(network: string | undefined, uid: string): string {
  const host = network === "base" ? "base.easscan.org" : "base-sepolia.easscan.org";
  return `https://${host}/attestation/view/${uid}`;
}
