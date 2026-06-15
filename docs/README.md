# docs — the settled spec for the litmus harness

These documents are the **source of truth** for the methodology, proof format, and design.
Anchor against them; don't relitigate them.

- [**how-it-works.md**](how-it-works.md) — diagram overview: connect → fingerprint → probe → grade → prove.
- [**litmus-test-v1.md**](litmus-test-v1.md) — the methodology: probe categories (C-01 injection,
  C-02 egress, C-03 sensitive-data), probe IDs, grading rules, and the v1 scope.
- [**onchain-proof-spec.md**](onchain-proof-spec.md) — the EAS attestation schema, the evidence-bundle
  shape, and the disclosed v1 trust model (reproducible, not unforgeable).
- [**technical-design.md**](technical-design.md) — package layout and how the pieces fit.
- [**deck.html**](deck.html) — the methodology deck.

> The hosted, operator-run grading **service** that runs this harness is documented in the
> separate `hosted-service` repo, not here.
