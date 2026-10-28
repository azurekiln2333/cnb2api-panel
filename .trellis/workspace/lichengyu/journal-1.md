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
