# Registration relay execution plan

## Approval gate

- [x] User approved task creation and planning.
- [x] Read repository evidence and applicable backend/frontend specifications.
- [x] Converge PRD into final requirements, scope and observable acceptance criteria.
- [x] Prepare design and curated implementation/check context manifests.
- [x] User explicitly approved the latest final planning summary with “继续”.
- [x] Ran `task.py start` after approval; implementation branch is `feat/registration-relay`.

## Implementation order

1. Backend implementer owns relay configuration validation, Store defaults/atomic persistence and the new relay coordinator module. Preserve credential encryption and old-store compatibility. Add pure/persistence tests first where they verify generation/restart behavior.
2. Backend integrator owns Pool/app/audit wiring and multi-panel HTTP tests. Integrate local-before-remote persistence, versioned relay receipts, one-hop handling and lifecycle stop/start. Keep existing registration responses unchanged.
3. Frontend implementer owns RoutingView (or an extracted relay component), relay DTO types, console status requests and focused browser tests. Reuse existing draft/save behavior. Do not store delivery state in editable settings.
4. Main session coordinates the shared API contract before parallel edits, reviews privacy/ordering behavior, updates backend/frontend specs and README, and aligns release versions.
5. A Trellis check agent reviews cross-layer contracts and fixes verified local defects. Run final checks, commit, tag and publish through GitHub/CNB/GitLab. Verify cloud image and release publication.
6. The user additionally requested a model-list page during continuation. Research the adjacent upstream source, implement an authenticated model inventory with existing Pool eligibility, and add desktop/mobile navigation, search, copy and meaningful browser/API coverage before final release checks.
7. The user additionally requested New API quota access. Implement gateway-key-authenticated native credit totals and OpenAI subscription/usage URL compatibility. Verify the actual New API subtraction, organization deduplication, frozen usage, incomplete data errors and safe responses. Document the OpenAI channel setup and CNB-credit unit.

Workers must use explicit file ownership, read task artifacts/native injected context, avoid overwriting others and communicate shared-interface changes before editing shared files. If Pool/Store ownership cannot be separated cleanly, make those edits sequential.

## Validation

- `node --test test/registration-relay.test.mjs test/panel-registration-relay.test.mjs` (final test filenames may follow existing patterns).
- `npm test` for backend regressions.
- `npm run build` for Vue typecheck and build.
- `npm run format:check` from `web`.
- `node node_modules/@playwright/test/cli.js test` from `web`.
- `python scripts/ste-lint-zh.py README.md` and any changed Chinese documentation files.
- `git diff --check` and package/tag version validation.
- Cloud tag tests, release package and container builds on GitHub and CNB.

## Final local verification (2026-10-29)

- Independent Trellis review passed. The review fixed HTTP-page peer ID creation
  and added a regression without relying on `crypto.randomUUID`.
- `npm test`: 302/302 passed, including relay, storage, model and quota coverage.
- Full Playwright suite: 43/43 passed in 1.3 minutes.
- Vue typecheck, production build and full console format check passed.
- README controlled-Chinese lint: zero findings. `git diff --check` passed.
- Release package `cnb2api-panel-v1.2.0-20261029.tar.gz` built and inspected.
  It includes both new runtime modules and the compiled console, excludes real
  environment and account data, and has SHA-256
  `d5e33a654d8a6fcfa574d59c621dc43007cae2b67b4086faa9f9f4c62234428f`.
- Cloud publication remains the final acceptance gate after committing/tagging.

## Risk checks

- Ordinary panel origins must not pass through the CNB-only workspace validator.
- No admin/gateway/PAT/proxy credential transfer or plaintext token copy in settings/stats/logs.
- Atomic local registration and outbox commit prevents lost updates at restart.
- The receiver receipt cursor prevents a late retry from restoring an older URI.
- Global bounds and per-pair serialization prevent fanout storms.
- Existing generated directories and unrelated older tasks remain outside commits.
- Rollback: disable relay on the primary; normal registration and existing server state continue.
