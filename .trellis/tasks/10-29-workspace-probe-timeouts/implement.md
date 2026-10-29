# Implementation plan

1. Review this plan before starting implementation.
2. Implement the Responses adapter and focused protocol tests in one worker.
3. Prioritize inference false-offline, automatic recovery and probe generation
   ownership in another worker. Add safe diagnostics and neutral public errors.
   This worker owns app/Pool integration using the agreed adapter contract.
   A frontend worker fixes bulk-probe availability, quota percentages, request
   outcome filtering and filtered export concurrently.
4. Add HTTP regressions for probe replacement and Responses transport.
5. Run `npm test`, relevant syntax checks and `npm run build`.
6. Run Trellis review, resolve findings and document the new backend contracts.
   Run Chinese lint on changed Chinese documentation.
7. Commit task-owned files, archive the task and record the journal.

## Ownership

- Adapter worker: `src/responses.mjs`, `test/responses.test.mjs`.
- Transport worker: `src/pool.mjs`, `src/app.mjs`, probe/HTTP integration tests.
- Coordinator: planning, specs, README/API documentation and finish.
- Frontend worker: account/overview quota and bulk probing, ActivityView filters
  and export, focused browser tests.

## Checks

Prove the old probe race with a local HTTP server. Cover credential replacement,
stale cleanup, deadlines and safe errors. Verify JSON/SSE, tools, usage, retries,
cancellation and limits. Preserve unrelated untracked setup and existing tasks.

## Progress

- User approved implementation after the final planning summary.
- Core transport, adapter and frontend implementation are complete.
- Independent review is complete. The final backend suite passes 235 checks.
- The full browser suite passes 31 tests. Formatting, typecheck and build pass.
- The user clarified that manual probing works with a fixed domain. The primary
  defect is the inference deadline/health-state interaction, not domain rotation.
