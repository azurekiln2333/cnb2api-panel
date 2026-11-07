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


## Session 5: Publish panel quota and health recovery fixes v1.2.2
<!-- trellis-session: v=2 fp=f835b6a5401a2b98 -->

**Date**: 2026-10-30
**Task**: Publish panel quota and health recovery fixes v1.2.2
**Branch**: `main`

### Summary

Published panel-only quota protection, probe recovery and registration heartbeat fixes to GitHub and CNB. Final v1.2.2 cloud publication verified.

### Main Changes

- Suspend accounts below ten percent and resume only after verified quota recovery; preserve manual enablement and background polling.
- Reject stale probe failures after successful inference, isolate models-only throttling and automatically migrate legacy false probe cooldowns.
- Preserve health and relay progress on same-URI registration heartbeats; publish only panel changes and leave unrelated CI work unstaged.

### Git Commits

| Hash | Message |
|------|---------|
| `e3b179e` | fix: protect quota and prevent stale health failures |
| `29acee2` | fix: automatically recover legacy probe cooldowns |

### Testing

- [OK] 346 backend tests, 45 browser tests, frontend build/typecheck/format, package and syntax checks passed.
- [OK] GitHub main 41040302441 and v1.2.2 tag 41040301735 completed successfully; all four tag jobs passed.
- [OK] CNB v1.2.2/latest digest 0bafa5d159c055d96640513e98d80405af2d29abde79e0d82bc116dcb6f3260c verified. Image source modules match tag bytes and compiled console reports 1.2.2.

### Status

[OK] **Completed**

### Next Steps

- Existing servers must pull the new panel image and recreate the panel container. CNB build logs require login; CNB publication was verified from the public image.


## Session 6: Release v1.2.3 quota compatibility and account resume
<!-- trellis-session: v=2 fp=e3f1a4c8e21ee2c0 -->

**Date**: 2026-10-30
**Task**: Release v1.2.3 quota compatibility and account resume
**Branch**: `main`

### Summary

Fixed omitted frozen Credits compatibility and safe quota diagnostics. Unified temporary quota pause and the existing enable action. Published and verified GitHub and CNB v1.2.3.

### Main Changes

- Preserve required allowance and usage validation while accepting omitted frozen usage as zero.
- Keep credential-free upstream HTTP, timeout, network, JSON and field-validation diagnostics in quotaSync.error.
- Resume temporary quota pauses through the existing account enable action; keep the override until verified recovery and clear it on manual disablement.

### Git Commits

| Hash | Message |
|------|---------|
| `f5cafe8` | fix: tolerate omitted frozen quota and preserve sync diagnostics |
| `91043bb` | fix: resume temporary quota pauses from the account enable action |

### Testing

- [OK] Backend: 385 passed. Browser: 46 passed. Console build, type check, format and Chinese prose checks passed.
- [OK] GitHub main 41070501112 and tag 41070500516 succeeded. All four tag jobs succeeded.
- [OK] CNB v1.2.3/latest digest 8862d91af161b85efd5eed1807a4e3c3eb28791ab7545fa0d085818044e77963. Four backend files match release commit byte-for-byte and compiled UI includes new pause/enable behavior.

### Status

[OK] **Completed**

### Next Steps

- Deploy v1.2.3 and inspect specific quota synchronization diagnostics if the production failure persists.
