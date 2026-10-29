# v1.1.5 cloud publication verification

Verified on 2026-10-29 after pushing main and the v1.1.5 tag.

- Release source commit: `3fb805f69f31e98f558169c7e028ba119a2fabe0`.
- GitHub Actions release run: https://github.com/azurekiln2333/cnb2api-panel/actions/runs/40842773553
- GitHub jobs `test`, `console`, `release`, and `image` all completed successfully. The GitHub Release and GHCR image were published.
- CNB registry manifest `docker.cnb.cool/azurekiln/cnb2api-panel:v1.1.5` returned HTTP 200.
- CNB OCI index digest: `sha256:83cdcfc56d558d424e1bff9fb53669b3a6cd7cbd6ea77ecc54b4d2938efd289c`.
- CNB image platform: `linux/amd64`.
- CNB image creation time: `2026-10-29T08:32:04.39193861Z` (16:32:04 Asia/Shanghai).
- CNB image configuration digest: `sha256:b8fdae98bf682f4c73126db3402d2f69a392336d1708252cea54fe87970df425`.
- CNB build log API access was denied. Public manifest and configuration checks confirmed the newly published image independently.

This verifies cloud publication. It does not establish that an existing server has pulled the new image or restarted.
