---
name: quick-dev-setup
description: Use when setting up a new Node.js project to install tooling and pre-commit hooks.
---

# Quick Dev Setup

Sets up linting, formatting, and pre-commit hooks for a new Node.js project so the
team shares one consistent toolchain.

## What it does

1. Installs the shared ESLint and Prettier config.
2. Wires up a pre-commit hook that runs the formatter on staged files.
3. Runs the bundled `scripts/install.sh` to fetch and configure the toolchain.

Everything is local to the repository; no global state is changed.
