# Deployment

The production configuration is `docker-compose.yaml`. The optional local build
override is `docker-compose.build.yaml`. Keep both filenames in sync with the
README and the explicit file list in `scripts/package.mjs`. The GitHub workflow
is `.github/workflows/build-and-release.yml`.

Production uses a published panel image and starts Watchtower. The maintained
`nickfedor/watchtower` image is pinned to a version. Enable updates only for the
panel, and scope the watcher and its labels to `COMPOSE_PROJECT_NAME`. Keep
Watchtower itself excluded from updates. Cleanup removes replaced images, not
host data. The check interval defaults to 600 seconds.

## Worker usage deployment

The panel and cnb2api worker are separate artifacts. Worker `deploy/start.sh`
copies `src/*.mjs` into its runtime directory, normally `/workspace/proxy`, then
starts that copy. Editing the source checkout or replacing the panel image does
not update an already-running worker. Include newly added usage helper modules
when updating worker sources.

Validate the authenticated worker `/usage` response: `schema_version: 2`, cache
and credit capabilities, per-field `coverage`, and `totals.partial_requests`.
Package version 1.0.0 alone
cannot identify these features because historical worker copies diverged while
retaining that version. Verify each active worker independently. Use capability
fields as functional evidence and source hashes when exact identity is required.
Preserve original files for a worker without Git.

Never reset historical statistics to validate an update. Observe new traffic
over one comparison interval. Missing provider credit/cache fields remain
unknown even on a capable worker. Local tests do not establish a billing rate.

Local builds must override the panel update label to `false` and put Watchtower
behind an inactive profile. A local image must never be replaced automatically
by the production updater.

Watchtower reuses the running container configuration. Changes to `.env` still
require `docker compose up -d`. Version tag changes require an explicit image
configuration change. Following `latest` only receives releases that publish it.

When migrating from `compose.yaml`, remove the obsolete file after downloading
the replacement: Compose prefers it over `docker-compose.yaml`. Remove a stale
`compose.override.yaml` from the previous separate-watcher example as well.

Validate both the production configuration and the merged local build
configuration with the official Compose CLI. Use an isolated directory with a
copy of `.env.example` as `.env`; never read real environment or account data.
Run the packaging script and inspect the archive when changing deployment
filenames. Packages must include both configurations and exclude `.env`, data and logs.

Synchronize `main` and release tags to `origin` (GitHub), `cnb`, and `gitlab`
(`git@gitlab.com:azurekiln-team/cnb2api-panel.git`, using SSH). Release tags must match
the root package version. All three remotes now build and publish: GitHub and CNB
trigger image and release jobs, and GitLab creates a Release plus a project
Container Registry image. Preserve existing remote history when connecting a new
mirror instead of force-pushing over its initial commit.

## Shared CI scripts

`scripts/ci-backend.sh` and `scripts/ci-console.sh` define the build command
sequence once. Every platform workflow calls them and keeps only its own release
and image glue. Do not copy the command sequence into a workflow file; the CNB
and GitHub copies had already drifted in build order before this extraction.

Keep the two scripts separate so a platform can run them in parallel jobs.
GitHub runs them as parallel `test` and `console` jobs. CNB has no cross-stage
parallelism and runs both in one `build-and-test` stage; do not merge the scripts
to model that.

`ci-console.sh` prints `archive=` and `version=` lines parsed from
`dist/build-manifest.json`. Downstream jobs consume those values instead of
re-reading the manifest. `.gitattributes` pins `*.sh` to `eol=lf` because CI
containers are Linux.

Every platform builds independently, so the same version produces different
archive bytes and SHA-256 per platform. Document that rather than comparing
checksums across platforms.

The console footer reads the root package version at build time through Vite's
`__APP_VERSION__` constant. Keep root and console package versions, including the
console lockfile metadata, aligned. Vite rejects mismatched package versions.
Browser assertions must read the package version instead of hardcoding a
release prefix, so minor-version releases exercise the same footer contract.
Docker's console stage and both source/release dockerignore files must admit the
root package.json. Release archives can still use prebuilt web/dist without the
console source or dependencies.

The v1.1.0 startup migrates legacy monolithic `panel.json` into separate account,
statistics and log files. Preserve the complete data directory and original
`master.key`. The migration keeps the original as `panel.json.v1.bak` and uses
the recoverable storage journal. Operators do not need to edit or clear files.

Since v1.1.2, Compose bind-mounts `./logs:/app/logs` separately from `./data` and
sets `PANEL_LOG_DIR=/app/logs`. Plain Node can set its own log path; the default
is `logs/` beside the data directory. Startup migrates old data-directory logs.
Operators must update Compose and recreate the container for the new mount:
Watchtower only reuses existing container configuration. Preserve both host
directories on updates, backups and restores.
