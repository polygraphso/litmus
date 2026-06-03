/**
 * One-time: register the litmus-v1 EAS schema on the selected network.
 *
 * Needs a funded EOA (`MINTER_PRIVATE_KEY`) and an RPC. Configured by the operator — see
 * internal notes. Records the schema UID to put in `.env`
 * (`NEXT_PUBLIC_EAS_SCHEMA_UID`).
 *
 *   pnpm --filter @polygraph/onchain register-schema
 *
 * (Equivalent zero-code path: base[-sepolia].easscan.org/schema/create.)
 */

import { SchemaRegistry } from "../eas-sdk.js";
import { ethers } from "ethers";
import { LITMUS_SCHEMA, networkConfig, selectedNetwork } from "../index.js";

async function main(): Promise<void> {
  const net = selectedNetwork();
  const cfg = networkConfig(net);

  const pk = process.env.MINTER_PRIVATE_KEY;
  if (!pk) throw new Error(`MINTER_PRIVATE_KEY is required (a funded EOA on ${net}).`);
  const rpc =
    (net === "base" ? process.env.BASE_MAINNET_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL) || cfg.rpc;

  const provider = new ethers.JsonRpcProvider(rpc, cfg.chainId);
  const signer = new ethers.Wallet(pk, provider);

  const registry = new SchemaRegistry(cfg.schemaRegistry);
  registry.connect(signer);

  process.stdout.write(`Registering the litmus-v1 schema on ${net}…\n  ${LITMUS_SCHEMA}\n`);
  const tx = await registry.register({
    schema: LITMUS_SCHEMA,
    resolverAddress: ethers.ZeroAddress,
    revocable: true,
  });
  const uid = await tx.wait();

  process.stdout.write(`\nSchema UID: ${uid}\n`);
  process.stdout.write(`→ set NEXT_PUBLIC_EAS_SCHEMA_UID=${uid} in .env / web/lib/eas.ts\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`register-schema failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
