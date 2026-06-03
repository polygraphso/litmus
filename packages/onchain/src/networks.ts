/**
 * Network constants (onchain-proof-spec §4). EAS contracts are OP-Stack
 * predeploys — identical on Base and Base Sepolia. The schema UID and bond
 * address are filled per-network after registration/deploy (env / web/lib).
 */

export type Network = "base-sepolia" | "base";

export interface NetworkConfig {
  chainId: number;
  rpc: string;
  eas: string;
  schemaRegistry: string;
  easscan: string;
  /** [verify] mainnet USDC at circle.com/usdc/addresses before the flip. */
  usdc: string;
}

export const NETWORKS: Record<Network, NetworkConfig> = {
  "base-sepolia": {
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    eas: "0x4200000000000000000000000000000000000021",
    schemaRegistry: "0x4200000000000000000000000000000000000020",
    easscan: "https://base-sepolia.easscan.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  base: {
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    eas: "0x4200000000000000000000000000000000000021",
    schemaRegistry: "0x4200000000000000000000000000000000000020",
    easscan: "https://base.easscan.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

export function selectedNetwork(): Network {
  return process.env.NEXT_PUBLIC_POLYGRAPH_NETWORK === "base" ? "base" : "base-sepolia";
}

export function networkConfig(net: Network = selectedNetwork()): NetworkConfig {
  return NETWORKS[net];
}
