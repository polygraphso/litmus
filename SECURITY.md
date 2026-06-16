# Security Policy

## Reporting a vulnerability

Please report security issues privately. **Do not open a public issue for a vulnerability.**

- Email: **security@polygraph.so**
- Or use GitHub's private vulnerability reporting ("Report a vulnerability" under the
  repository's Security tab).

Please include a description, reproduction steps, affected versions, and any proof-of-concept.
We aim to acknowledge reports within a few business days and will coordinate a disclosure
timeline with you.

## Scope

This repo is the **`@polygraphso/litmus` harness** — a tool that grades third-party MCP servers.
Two distinct things are worth separating:

- **Findings the harness reports about a graded server** (injection, egress, data leakage) are
  the harness's *product*, not vulnerabilities in the harness. Report those through the normal
  grading flow, not here.
- **Vulnerabilities in the harness itself** are in scope — for example, a way to escape the
  egress sandbox, to make the harness execute attacker code outside the sandbox, to forge or
  corrupt an evidence bundle, or a flaw that lets a graded server tamper with the grading host.

## A note on the sandbox

The harness runs untrusted MCP servers to grade them, including network-egress probes inside a
hardened default-deny Docker sandbox (gVisor in production). Treat the sandbox boundary as the
critical trust boundary; sandbox-escape reports are high priority.

## Disclosed trust trade-offs (not vulnerabilities)

The v1 trust model is documented at [polygraph.so](https://polygraph.so):
self-run, self-minted grades are forgeable but **falsifiable** (the open harness lets anyone
re-run and disprove a false grade), and a graded server that detects the test context can evade
it. These are disclosed limitations of v1, not bugs — please don't file them as vulnerabilities.

## Supported versions

Security fixes target the latest published `@polygraphso/litmus` minor release.
