import { defineConfig } from "tsup";
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  // Entries: the library (index), the two CLI bins (servers + skills), and the
  // MCP server bin.
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "cli-skill": "src/cli-skill.ts",
    mcp: "src/mcp.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  // `resolve: true` makes the .d.ts bundler follow imports into node_modules and
  // inline them, so the published declarations are self-contained (no dangling
  // `export * from "@polygraph/core"` that consumers can't resolve).
  dts: { resolve: true },
  splitting: true,
  clean: true,
  shims: false,
  // tsup externalizes `dependencies` automatically (the MCP SDK, ethers, zod,
  // tsx) and bundles everything else — so the internal `@polygraph/*`
  // workspace packages (listed under devDependencies) get inlined here, leaving
  // a published manifest with no workspace deps. `noExternal` also forces their
  // *types* to be inlined into the .d.ts (otherwise the declaration files keep
  // dangling `export * from "@polygraph/core"` that consumers can't resolve).
  noExternal: [/^@polygraph\//],
  onSuccess: async () => {
    // The harness's egress sandbox reads non-TS Docker assets at runtime; ship
    // them next to the bundle as `dist/docker` (egress-runner.ts probes for it).
    await cp(here("../probes/docker"), here("dist/docker"), { recursive: true });
  },
});
