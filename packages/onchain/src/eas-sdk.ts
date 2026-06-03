/**
 * eas-sdk interop shim.
 *
 * eas-sdk 2.9.1 ships a broken ESM build: `offchain/typed-data-handler.js` does
 * `import { isEqual } from "lodash"`, which Node's native ESM rejects (lodash is
 * CommonJS — no named exports), and the package's `exports.import` condition
 * routes there. So a plain `import { SchemaEncoder } from
 * "@ethereum-attestation-service/eas-sdk"` crashes under tsx/node ESM. Load the
 * CommonJS build via createRequire instead; the type-only cast keeps full
 * typings. See onchain-proof-spec.md §8 ([verify] eas-sdk).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sdk = require(
  "@ethereum-attestation-service/eas-sdk",
) as typeof import("@ethereum-attestation-service/eas-sdk");

export const { EAS, SchemaEncoder, SchemaRegistry } = sdk;
