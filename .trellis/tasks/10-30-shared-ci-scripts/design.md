# Shared CI scripts

## Boundary

`scripts/ci-backend.sh` and `scripts/ci-console.sh` are the only places that
define the build command sequence. Every CI platform calls them and adds only
platform-specific release and image glue.

- `scripts/ci-backend.sh` — `node`/`npm` versions, then `npm test`.
- `scripts/ci-console.sh` — `npm ci --prefix web`, format check, `vue-tsc` build,
  Playwright browser install, e2e, then `node scripts/package.mjs`. It prints
  `archive=` and `version=` lines parsed from `dist/build-manifest.json`.

Both `cd` to the repository root from `BASH_SOURCE`, so a caller may run them
from any working directory. Both read no CI-specific variables, which is what
keeps them portable across CNB, GitHub, GitLab, GitCode and Gitee.

## Parallelism

Keep the two entry points separate. The GitHub workflow runs them as parallel
`test` and `console` jobs; CNB has no cross-stage parallelism, so it runs them
sequentially inside one `build-and-test` stage. Do not merge them into one
script — that would serialize GitHub.

The `console` job needs the archive name for its artifact upload and for
`release`/`image` via `needs.console.outputs`. `ci-console.sh` therefore prints
machine-readable `archive=` and `version=` lines; the workflow greps them into
`$GITHUB_OUTPUT`. Do not parse `build-manifest.json` again in the workflow.

## Version bumping

`package.json`, `web/package.json` and both version fields in
`web/package-lock.json` must stay in sync. `web/vite.config.ts` throws when the
console and root versions differ, so a partial bump fails at build time rather
than at release time. `scripts/package.mjs` and both tag validators compare the
tag against `package.json`, so the tag must be `v<version>` exactly.

## Platform matrix

| Platform | File | Release | Image | Notes |
| --- | --- | --- | --- | --- |
| GitHub | `.github/workflows/build-and-release.yml` | `gh release` | GHCR | `test` and `console` run in parallel |
| CNB | `.cnb.yml` | `git:release` + attachments | `docker.cnb.cool` | serial stages |
| GitLab | `.gitlab-ci.yml` | `release:` keyword | project Container Registry | `release` and `image` need `console` |

GitCode and Gitee are not wired up. Neither offers durable versioned package
storage. See `gitcode-gitee-assessment.md` for the evidence and the condition
that would change the decision.

Each platform builds independently, so the archive bytes and SHA-256 differ per
platform for the same version. The checksum beside each download is
authoritative; do not compare across platforms.

## Line endings

`.gitattributes` pins `*.sh text eol=lf`. CI containers are Linux, and a CRLF
shebang or `set -euo pipefail` line fails there. Keep that rule.
