---
name: Bug report
about: Report a defect in the harness itself
title: ""
labels: bug
assignees: ""
---

<!--
Before filing:
- A security vulnerability in the harness? Do NOT file it here — see SECURITY.md for private reporting.
- Disagree with a grade a server got? That's the harness's product, not a bug. The harness is
  open and deterministic — re-run `litmus` against the same server to reproduce or refute the grade.
-->

- [ ] This is a defect in the harness, not a grade I disagree with.
- [ ] This is not a security vulnerability (those go to SECURITY.md).

## What happened

<!-- A clear description of the bug. -->

## Steps to reproduce

<!-- The exact command and target, e.g.:
     polygraphso-litmus litmus npm/@modelcontextprotocol/server-filesystem -->

1.
2.

## Expected vs. actual

<!-- What you expected, and what happened instead. Include the grade/output if relevant. -->

## Environment

- `@polygraphso/litmus` version: <!-- polygraphso-litmus --version -->
- Node version: <!-- node --version -->
- OS:
- Docker available? <!-- yes / no — affects C-02 (egress); without it the grade caps at B -->

## Logs / output

<!-- Relevant CLI output (run with --json for the machine-readable evidence bundle).
     Redact anything sensitive before pasting. -->
