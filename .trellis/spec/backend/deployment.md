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
filenames. Packages must include both configurations and exclude `.env` and data.

Synchronize `main` and release tags to `origin` (GitHub), `cnb`, and `gitlab`
(`git@gitlab.com:azurekiln-team/cnb2api-panel.git`, using SSH). Release tags must match
the root package version. GitHub and CNB tags trigger image and release builds;
GitLab currently mirrors the source and tags. Preserve existing remote history
when connecting a new mirror instead of force-pushing over its initial commit.
