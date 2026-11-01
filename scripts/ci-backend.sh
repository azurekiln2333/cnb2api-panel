#!/usr/bin/env bash
# Backend test stage shared by every CI platform.
# Keep this file platform-neutral: read no CI-specific variables here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

node --version
npm --version
npm test
