/**
 * Pin the evidence bundle (onchain-proof-spec §6 — the proof-layer pinning
 * primitive). Pinata IPFS is primary; the Supabase `litmus_bundles` REST store
 * is the fallback, returning a `report:<id>` identifier. The web `/api/pin`
 * route keeps its own sanctioned vendored copy; the agent mint script and the
 * hosted runner share THIS module.
 *
 * The request bodies are byte-identical to the prior hand-rolled copies so the
 * Pinata CID stays continuous. Every fetch carries a 30 s abort timeout: a hung
 * Pinata/Supabase must not wedge the hosted runner's single worker loop.
 */

import type { EvidenceBundle } from "@polygraph/core";

/** Hard timeout on every pin fetch (Pinata + Supabase). */
export const PIN_TIMEOUT_MS = 30_000;

export interface PinResult {
  cid: string;
  via: "pinata" | "supabase";
  gateway?: string;
}

/**
 * Pin to IPFS (Pinata) with a Supabase fallback. A non-ok Pinata response (or a
 * network error) falls through to Supabase; with neither backend configured we
 * throw. CID continuity: the `pinataContent`/`pinataMetadata` body must not change.
 */
export async function pinEvidence(bundle: EvidenceBundle): Promise<PinResult> {
  const jwt = process.env.PINATA_JWT;
  if (jwt) {
    try {
      const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ pinataContent: bundle, pinataMetadata: { name: "litmus-bundle" } }),
        signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
      });
      if (res.ok) {
        const d = (await res.json()) as { IpfsHash: string };
        return { cid: `ipfs://${d.IpfsHash}`, via: "pinata", gateway: `https://gateway.pinata.cloud/ipfs/${d.IpfsHash}` };
      }
      process.stderr.write(`    (pinata ${res.status} — falling back to Supabase)\n`);
    } catch {
      /* fall through */
    }
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const res = await fetch(`${url}/rest/v1/litmus_bundles`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
      body: JSON.stringify({ bundle }),
      signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
    });
    if (res.ok) {
      const rows = (await res.json()) as Array<{ id: string }>;
      return { cid: `report:${rows[0]!.id}`, via: "supabase" };
    }
    throw new Error(`supabase ${res.status}: ${await res.text()}`);
  }
  throw new Error("no pinning backend available (Pinata scopes + no Supabase)");
}
