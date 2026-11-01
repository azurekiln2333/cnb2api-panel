#!/usr/bin/env bash
# Console stage shared by every CI platform: format check, typecheck + build,
# browser install, e2e, then the standalone release package.
#
# Runs independently of scripts/ci-backend.sh so a platform can execute both in
# parallel jobs. Prints the release archive name and version to stdout in a
# "key=value" form that every platform wrapper can parse.
# Keep this file platform-neutral: read no CI-specific variables here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

npm ci --prefix web
npm --prefix web run format:check
npm --prefix web run build
npx --prefix web playwright install --with-deps chromium
npm --prefix web run test:e2e
node scripts/package.mjs

read_field() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const { [process.argv[1]]: value } = JSON.parse(readFileSync("dist/build-manifest.json", "utf8"));
    process.stdout.write(String(value));
  ' "$1"
}

archive=$(read_field archive)
version=$(read_field version)
printf 'archive=%s\nversion=%s\n' "$archive" "$version"
