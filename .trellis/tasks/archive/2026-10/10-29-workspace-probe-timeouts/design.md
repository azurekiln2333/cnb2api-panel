# Design

## Probe lifecycle

The user's later evidence identifies a second path: manual models checks work,
but inference requests then mark accounts offline. `Pool.forward` currently
uses the short connect setting until headers, even though workers can withhold
headers until model output or complete non-streaming generation. Use the inference
idle budget for the first response. Confirm failed inference transport through
authenticated models readiness before classifying workspace connectivity.
Automatic recovery checks must run during routing cooldown. Preserve HTTP
auth/rate/capacity backoff rather than letting a models check bypass it.
Repeated confirmed unreachable connections may use the existing autoWake policy.

Associate in-flight work with endpoint and proxy key. Reuse work only for the
same connection generation. A changed connection starts fresh work. Cleanup
must check promise ownership before deleting the current map entry.

Keep `/v1/models` as authenticated readiness. Bound JSON reads under the
configured deadline. Classify safe error categories without logging exception
text or response bodies. Do not increase timeouts blindly or treat public
`/health` as proof of authenticated readiness.

## Responses boundary

A separate adapter validates input, converts requests to Chat, and converts
Chat JSON/SSE into Responses. `Pool.forward` retains transport, retries and
accounting. Track client and upstream paths independently. Apply Chat overrides
to converted requests and capture original Chat usage before response conversion.

Map instructions, messages, text/image blocks, function calls/results, tools,
tool choice, output limits and supported JSON formats. Reject unsupported
semantic features before dispatch. Optional encrypted-reasoning projections
may be empty, but encrypted state input cannot be synthesized or replayed.

Emit the Responses lifecycle with stable item references. Handle fragmented
SSE/UTF-8, tool deltas and incomplete output. Interrupted upstream streams must
not produce false completion. Bound buffered JSON and single events. Respect
backpressure and client disconnect cancellation.

## Compatibility and rollback

Frontend scope also includes dedicated bulk-probe busy state, remaining quota
percentages, and an outcome filter for request logs. The export uses the same
filtered collection as the table before pagination. Public exhaustion errors use
neutral service-unavailable wording; management logs retain actionable context.

An optional runtime failure category is saved with existing health statistics.
No storage version migration or runtime dependency is required. Chat and Messages keep
their relay paths. Revert the adapter and its integration together if necessary.
The live timeout category remains subject to the user's complete error or live
verification. Disclose that limit if unavailable.
