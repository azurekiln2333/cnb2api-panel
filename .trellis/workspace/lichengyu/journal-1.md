# Journal - lichengyu (Part 1)

> AI development session journal
> Started: 2026-10-25

---



## Session 1: Release v1.1.4 with DSH compatibility
<!-- trellis-session: v=2 fp=fb4c4b1eb5d42cfa -->

**Date**: 2026-10-29
**Task**: Release v1.1.4 with DSH compatibility
**Branch**: `main`

### Summary

Published v1.1.4 on GitHub and CNB. GitHub tag workflow passed all four jobs. Verified published CNB source, default DSH preset and console version. Workspace header propagation changes remain local under sibling task.

### Main Changes

- All Chat Completions developer messages normalize to system while the default DSH preset is enabled.

### Git Commits

| Hash | Message |
|------|---------|
| `5b74a62` | feat: add DSH compatibility and request diagnostics |
| `e9960db` | chore(release): prepare v1.1.4 |

### Testing

- [OK] Focused developer-role regression passed. Build/package and checksum passed. GitHub backend, console, release and image jobs passed.

### Status

[OK] **Completed**

### Next Steps

- Publish the separately modified workspace proxy when its source repository is confirmed.


## Session 2: v1.1.5 gateway recovery and Responses release
<!-- trellis-session: v=2 fp=36180e141ed3db03 -->

**Date**: 2026-10-29
**Task**: v1.1.5 gateway recovery and Responses release
**Branch**: `main`

### Summary

Fixed inference false-offline detection, probe races and cooldown recovery with automatic wake. Added Responses-to-Chat conversion, usable bulk probes, quota percentages, request outcome filters and filtered JSON export. Passed 235 backend tests and 31 browser tests plus the updated access sample test. Pushed main and v1.1.5 to GitHub and CNB to trigger cloud builds, and synchronized GitLab. Cloud build completion remains pending.

### Git Commits

| Hash | Message |
|------|---------|
| `3fb805f` | fix: restore gateway health and bridge Responses in v1.1.5 |

### Status

[OK] **Completed**


## Session 3: Codex Responses compatibility v1.1.7
<!-- trellis-session: v=2 fp=35003f34504bf230 -->

**Date**: 2026-10-29
**Task**: Codex Responses compatibility v1.1.7
**Branch**: `main`

### Summary

Fixed Codex client_metadata rejection, namespace/custom tool mapping, full-history round trips and streamed tool-name fragments. Validated with a strict Chat-only upstream, 252 backend tests, 35 browser tests, build/typecheck/format, package checksum and a real isolated Codex CLI 0.164.0 two-turn tool run. Documented hosted-search and remote-compaction limits plus tested provider settings. Published main and v1.1.7 to GitHub, CNB and GitLab. GitHub tag run 40860960492 passed test, console, release and image jobs. CNB v1.1.7 and latest share index sha256:495d9789c7cb3a6c87b05fa5b3a16b31f9a0d8a20dc7622d0a315b919837c4f4; amd64 image created 2026-10-29T10:52:42Z. Existing untracked workspace scaffolding and old tasks were left outside the release.

### Git Commits

| Hash | Message |
|------|---------|
| `e856370` | fix: bridge Codex Responses requests in v1.1.7 |

### Status

[OK] **Completed**


## Session 4: v1.2.0 registration relay, model inventory and New API quota
<!-- trellis-session: v=2 fp=b9c56e355a4d362f -->

**Date**: 2026-10-29
**Task**: v1.2.0 registration relay, model inventory and New API quota
**Branch**: `feat/registration-relay`

### Summary

Released registration relay, model inventory and New API quota; all local checks and GitHub/CNB publication passed.

### Main Changes

- Durable single-hop registration relay with independent settings and runtime status.
- Read-only model inventory page with source labels, route readiness, search and copy.
- Gateway-key CNB credit totals and New API OpenAI billing compatibility with organization deduplication.

### Git Commits

| Hash | Message |
|------|---------|
| `005f725` | feat: relay registrations and expose models and quota in v1.2.0 |

### Testing

- [OK] 302 backend tests and 43 browser tests passed; build/typecheck/format, README lint, package and diff checks passed.
- [OK] GitHub tag run 40887617458 all four jobs succeeded; CNB v1.2.0/latest OCI index bcdeb4f20b9a2403d1c5f773352304871351f43a3591d07d89226dcd4ff3c17f verified.

### Status

[OK] **Completed**
