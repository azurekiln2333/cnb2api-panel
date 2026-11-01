# Extract shared CI scripts and add GitLab, GitCode, Gitee pipelines

## Goal

Move the duplicated build/test/package command sequence out of `.cnb.yml` and
`.github/workflows/build-and-release.yml` into reusable shell scripts, preserve
every platform's current job parallelism, bump the release version to 1.2.1, and
add a GitLab pipeline as the third publishing platform. Then assess whether
GitCode and Gitee can host the same pipeline and add them only where their
capabilities actually allow release plus package publishing.

## Background and Evidence

- `.cnb.yml` runs install, backend test, format check, package, browser install
  and e2e as one serial `build-and-test` stage.
- `.github/workflows/build-and-release.yml` runs backend tests in a separate
  parallel `test` job and the console steps in a `console` job.
- The two files maintain the same command sequence twice, and the sequences have
  already drifted: CNB relies on `npm run package` performing the console build
  implicitly, GitHub runs `npm run build` and `scripts/package.mjs` separately.
- `scripts/package.mjs` is the single real implementation; it is not duplicated.
- The user requires that the existing CNB and GitHub cloud builds keep working.
- The user explicitly requires preserving parallelism; the extraction must not
  serialize the GitHub `test` and `console` jobs.

## Requirements

- R1: Extract the shared command sequence into scripts under `scripts/`. Keep at
  least two entry points so a platform can run backend tests and console work in
  parallel jobs.
- R2: Rewrite `.cnb.yml` and `.github/workflows/build-and-release.yml` to call the
  shared scripts. Preserve the existing GitHub `test` / `console` parallelism and
  the CNB stage structure and job names.
- R3: Keep every existing output contract that downstream steps consume:
  `dist/build-manifest.json`, `dist/$RELEASE_ARCHIVE`, its `.sha256`, and the
  `archive` / `version` step outputs.
- R4: Make the shared scripts platform-neutral. They must not read GitHub-only or
  CNB-only environment variables; platform-specific glue stays in the workflow.
- R5: Bump `package.json` version to 1.2.1 and keep tag validation consistent with
  the new version.
- R6: Add a GitLab pipeline that builds, tests, packages, publishes a GitLab
  Release with the archive and checksum, and pushes the container image.
- R7: Assess GitCode and Gitee. Add a pipeline only if the platform provides both
  a release mechanism and durable package/artifact storage. Otherwise report the
  specific missing capability instead of shipping a broken workflow.
- R8: Document the multi-platform release contract, including that each platform
  builds independently and therefore produces a different archive hash.

## Acceptance Criteria

- [x] AC1 (R1, R4): Shared scripts run standalone on a clean checkout and contain
      no platform-specific variables.
- [x] AC2 (R2): `.cnb.yml` build, release and image jobs keep their names, trigger
      conditions and outputs. GitHub `test` and `console` still run as parallel
      jobs.
- [x] AC3 (R3): `npm run package` output, manifest fields and checksum naming are
      unchanged.
- [x] AC4 (R5): `package.json` reports 1.2.1 and both tag validators expect
      `v1.2.1`.
- [x] AC5 (R6): A GitLab pipeline definition exists that produces the release
      archive, a GitLab Release and a registry image on a `v*` tag.
- [x] AC6 (R7): The GitCode and Gitee decision is recorded with concrete evidence
      for each platform's release and package support.
- [x] AC7: `npm test` (302 pass), console format check, console build and e2e
      (43 pass) run locally.

## Out of Scope

- Reproducible builds and cross-platform hash equality.
- Mirroring configuration between remotes.
- Changing `scripts/package.mjs` output format.
- Removing or replacing the existing CNB or GitHub pipelines.
