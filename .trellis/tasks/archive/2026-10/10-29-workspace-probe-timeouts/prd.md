# Fix workspace probes and bridge Responses

## Goal

Restore trustworthy probes and accept Responses clients through the panel when
the workspace supports only Chat Completions.

## Background

- The user reports that connected workspaces all time out during probes.
- The user explicitly requests panel-side Responses-to-Chat conversion.
- Follow-up: the domain stays fixed and manual probes succeed. Inference failures
  repeatedly mark accounts offline. Fixing endpoint replacement alone is insufficient.
- `src/pool.mjs:257` deduplicates probes by account ID alone. A reproduced
  endpoint replacement reuses obsolete work and leaves the new workspace pending.
- `src/pool.mjs:315` collapses timeout, network and invalid-response failures.
  The live failure category cannot yet be determined from local data.
- `src/app.mjs:397` omits Responses. `src/pool.mjs:782` forwards the original
  path. The prior compatibility task remains in planning without an adapter.

## Requirements

1. Probe the current endpoint and credential pair after registration or edits.
   Obsolete work must not suppress or overwrite a newer probe generation.
2. Bound model response reads and distinguish timeout, connection, HTTP,
   authentication and invalid-response errors without exposing secrets.
3. Accept authenticated POST and OPTIONS on `/v1/responses`. Convert upstream
   requests to `/v1/chat/completions` and return Responses JSON or SSE.
4. Support stateless text, message history, image URLs, function tools and tool
   results. Preserve stable IDs, tool arguments, status and actual token usage.
5. Preserve retries, cancellation, backpressure, affinity, request overrides and
   safe logging. Keep existing Chat and Messages behavior compatible.
6. Reject unsupported stateful operations, hosted tools and unsupported content
   explicitly. Never fabricate reasoning, capability or usage values.
7. Separate inference first-response deadlines from authenticated health checks.
   Confirm workspace reachability before calling a provider delay an offline worker.
   Health recovery must not wait for a routing cooldown to expire.
8. Repeated confirmed connection failures trigger automatic wake when enabled,
   including during routing cooldown. Preserve the existing wake throttle.
9. Keep bulk probing available during unrelated account operations and polling.
10. Display remaining quota count, total and percentage together.
11. Filter API request logs by all/success/failure and export all matching rows
    after applying the current filters, regardless of pagination.
12. Return a neutral public service-unavailable error instead of account,
    workspace or cooldown troubleshooting details. Keep diagnostics in admin logs.

## Acceptance Criteria

- A regression test changes an endpoint or key during an active probe. The
  replacement is checked immediately and becomes eligible on success.
- Obsolete probe success, failure and cleanup cannot change current state.
- Tests distinguish stalled headers/body, HTTP/auth errors, malformed models
  and network failures without leaking credentials or raw response bodies.
- HTTP tests prove both Responses modes use only the upstream Chat endpoint.
- Tests cover text, tools/results, split SSE, usage, errors, disconnects,
  unsupported input, authentication and preflight behavior.
- Existing backend tests and the production build pass.
- Slow valid inference requests remain available after a successful probe.
- Cooling accounts recover automatically. Repeated unreachable accounts wake
  only when enabled, eligible and outside the automatic-wake throttle.
- Bulk probe works during unrelated actions. Completed batches release busy state.
- Quota renders `7166/7166 100%`, with unknown values for missing/zero totals.
- Browser tests verify request outcome filtering and export of filtered results.
- Public 503 responses omit internal routing details and preserve retry metadata.

## Scope

Both changes meet in `Pool`, so this task owns their integrated validation.
Workspace source changes, response storage/retrieval and production deployment
are outside this fix. Local tests cannot establish production reachability.
