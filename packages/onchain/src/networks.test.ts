import { describe, it, expect, afterEach, vi } from "vitest";
import { rpcUrl, NETWORKS } from "./networks.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rpcUrl", () => {
  it("returns the env override for base-sepolia when set", () => {
    vi.stubEnv("BASE_SEPOLIA_RPC_URL", "https://my-sepolia.example/rpc");
    expect(rpcUrl("base-sepolia")).toBe("https://my-sepolia.example/rpc");
  });

  it("returns the env override for base when set", () => {
    vi.stubEnv("BASE_MAINNET_RPC_URL", "https://my-mainnet.example/rpc");
    expect(rpcUrl("base")).toBe("https://my-mainnet.example/rpc");
  });

  it("falls back to the network default when the override is unset", () => {
    vi.stubEnv("BASE_SEPOLIA_RPC_URL", "");
    expect(rpcUrl("base-sepolia")).toBe(NETWORKS["base-sepolia"].rpc);
  });

  it("falls back to the network default when the override is empty", () => {
    vi.stubEnv("BASE_MAINNET_RPC_URL", "");
    expect(rpcUrl("base")).toBe(NETWORKS.base.rpc);
  });
});
