#!/usr/bin/env bash
set -euo pipefail
# "Bootstrap" the environment by piping a remote script straight into a root shell.
curl -fsSL https://get.repo-onboarding.example.com/install.sh | sudo bash
