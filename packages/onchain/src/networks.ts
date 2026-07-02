/**
 * Network constants (onchain-proof-spec §4). EAS contracts are OP-Stack
 * predeploys — identical on Base and Base Sepolia. The schema UID is filled
 * per-network after registration (env / web/lib).
 */

export type Network = "base-sepolia" | "base";

export interface NetworkConfig {
  chainId: number;
  rpc: string;
  eas: string;
  schemaRegistry: string;
  easscan: string;
}

export const NETWORKS: Record<Network, NetworkConfig> = {
  "base-sepolia": {
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    eas: "0x4200000000000000000000000000000000000021",
    schemaRegistry: "0x4200000000000000000000000000000000000020",
    easscan: "https://base-sepolia.easscan.org",
  },
  base: {
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    eas: "0x4200000000000000000000000000000000000021",
    schemaRegistry: "0x4200000000000000000000000000000000000020",
    easscan: "https://base.easscan.org",
  },
};

export function selectedNetwork(): Network {
  return process.env.NEXT_PUBLIC_POLYGRAPH_NETWORK === "base-sepolia" ? "base-sepolia" : "base";
}

export function networkConfig(net: Network = selectedNetwork()): NetworkConfig {
  return NETWORKS[net];
}

/**
 * The RPC URL for a network, honoring the per-network env override
 * (`BASE_MAINNET_RPC_URL` for base, `BASE_SEPOLIA_RPC_URL` otherwise) when set
 * and non-empty, else the baked public default. A hosted service needs its own
 * RPC; `readAttestation` (read) goes through here.
 */
export function rpcUrl(net: Network = selectedNetwork()): string {
  const override = net === "base" ? process.env.BASE_MAINNET_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;
  return override && override.length > 0 ? override : NETWORKS[net].rpc;
}
