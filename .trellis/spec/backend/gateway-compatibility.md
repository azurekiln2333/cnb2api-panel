# Gateway health and Responses compatibility

## Scope / Trigger

Use this contract when changing `Pool.forward`, probes, automatic recovery or
the stateless Responses bridge. A reachable workspace and a successful model
generation are different observations.

## Signatures

- `Pool.probe(id)`: authenticated, bounded `GET <endpoint>/v1/models` check.
- `Pool.confirmConnectionFailure(source)`: confirm inference transport failure
  against the current endpoint, key and successful-health generation.
- `Pool.recover(id)`: apply enabled-account, credentials and auto-wake policy.
- `POST /v1/responses`: gateway-key authenticated Responses input.
- `prepareResponsesRequest(payload)`: return `{ payload, toolContext }` with the
  Chat request and request-scoped reverse tool mappings.
- `toChatRequest(payload)`: return only the prepared Chat payload for callers
  that do not need output conversion.
- `toResponsesResponse(body, { model, requestId, toolContext })`: map Chat JSON.
- `ResponsesStream({ model, requestId, toolContext }).push(bytes)/finish()`: return `Buffer[]`
  containing named Responses SSE events.

## Contracts

Keep probe time bounded by `connectTimeoutSeconds`. Use `idleTimeoutSeconds`
for inference first response and subsequent reads: workers may wait for model
output or a complete non-streaming generation before sending response headers.
Do not classify that entire interval as a TCP connection timeout.

Deduplicate probes only for the same endpoint/key. An obsolete promise must not
delete newer work. A newer successful probe invalidates old inference transport
failures. Completed successful inference also advances that generation and
repairs older connection failures for the same endpoint/key. Actual inference
HTTP rate/auth/capacity responses still establish route cooldown. An earlier
in-flight probe must not erase a newer upstream cooldown.
Read at most 256 KiB of models JSON and require `{ object: "list", data: [] }`.
Persist `failureKind` as runtime state in stats, not account definitions.
Connection failures remain eligible for periodic recovery during route cooldown.
Upstream/auth/rate/capacity and invalid-response cooldowns stay effective across
process restarts. Repeated confirmed connection failures may trigger auto-wake
at three failures; preserve the existing 30-minute successful-wake throttle.

A 429 from the models probe is inconclusive about inference availability. Keep
existing routing health, use an independent automatic-probe backoff and never
wake a workspace because its models endpoint is throttled. Manual probes can
retry immediately. Honor bounded Retry-After seconds or HTTP dates on probes
and actual inference 429 responses. Coalesce routing failures already in flight
when a newer provider cooldown was established; do not exponentially extend one
concurrent burst into hours. A longer explicit provider deadline may extend it.
Keep probe backoff in memory and real routing cooldown in persistent runtime.

Responses requests always use upstream `/v1/chat/completions`. Convert before
Chat request overrides and usage-option merging. Derive session affinity and
previews from the original semantic messages. Preserve the accepted client
route in logs. Capture raw Chat usage before response conversion to avoid
Anthropic input/cache accounting rules on Responses usage.

Support stateless text/history, image URLs, function calls and results, tools,
JSON formats, refusal and incomplete generation. JSON output and SSE use stable
response/item/call IDs. SSE supports fragmented UTF-8, separate tool indices,
increasing sequence numbers and trailing usage. Emit completion only after a
valid terminal Chat choice. Bound response state to 8 MiB and one event to 1 MiB.
Keep retries before response headers only, abort on client disconnect, and await
downstream drain. Existing Chat and Messages continue through their normal paths.

Codex client metadata is a transport field. Validate its string-map shape on
Responses input and omit it from Chat payloads. Strip `client_metadata` at the
final Chat forwarding boundary too, including native Chat requests and request
overrides. Preserve standard `metadata`. Accept bounded reasoning projection
options (`reasoning.context`, `stream_options.reasoning_summary_delivery`) without
forwarding Responses-only keys. Accept default `access_programs.cyber` selection
only; reject non-default access plans before routing.

Flatten namespace and custom tool definitions to deterministic, collision-free
Chat function names of at most 64 characters. Keep reverse mappings local to
the request; reserve ordinary function names before assigning aliases. Preserve
`call_id`, namespace and custom input across full-history turns. Convert custom
tools to a function with one required string `input`; include grammar as advisory
description because Chat cannot enforce it. Decode the complete JSON arguments
before emitting custom input. JSON and SSE must restore `custom_tool_call` and
namespace. Custom SSE emits `response.custom_tool_call_input.delta/done` followed
by a complete `response.output_item.done`, which Codex needs to execute the tool.

Ignore echoed opaque reasoning/projection history while preserving visible
messages and executable tool history. Never decrypt or fabricate reasoning.
Stateful references, hosted tools, compaction and unsupported content remain
explicit HTTP 400 errors. Hosted search errors tell Codex users to configure
`web_search="disabled"`. Codex providers must use HTTP and local compaction
(`supports_websockets=false`, `capabilities.remote_compaction="unsupported"`).
Do not forward unsupported hosted tools as if the client could execute them.

Validation errors expose bounded safe `param` and `code` strings. Do not include
payload values or unsafe property names. Keep unknown semantic options explicit
instead of silently discarding them.

Return a neutral public 503 message with request ID and retry metadata.
Management logs retain safe internal failure categories, never raw exceptions,
provider bodies or credentials.

## Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Slow inference, authenticated models succeeds | Preserve worker health |
| DNS/TLS/refused connection or probe timeout | Safe category, connection failure |
| Probe HTTP auth failure or invalid models | Explicit safe error, no pointless wake |
| Old endpoint/key or older health generation | Ignore stale mutation |
| Persisted upstream cooldown | Do not bypass via automatic models check |
| Models probe returns 429 while inference works | Preserve routing, retry probe automatically |
| Completed inference precedes an older probe timeout | Ignore stale timeout |
| Concurrent actual inference 429 responses | One cooldown, respect Retry-After |
| Unsupported state/hosted tool/content | HTTP 400 before account selection |
| Malformed or interrupted Chat output | Failure, never false completion |
| No ready account or exhausted retries | Public service-unavailable HTTP 503 |

## Good / Base / Bad Cases

Good: a model returns after the probe timeout but within the inference idle
budget; the result succeeds and the account remains healthy.
Base: a full-history Responses request reaches a Chat-only mock worker and
returns Responses JSON/SSE with original measured usage.
Bad: mark a worker offline because generation exceeded the short probe deadline,
or forward Responses unchanged to an unsupported upstream route.

## Tests Required

`test/panel-probes.test.mjs` proves slow first response, health generation,
endpoint/key replacement, bounded body/timeout diagnostics, recovery in cooldown,
failure categories, persisted cooldowns and automatic-wake throttling.
`test/panel-rate-recovery.test.mjs` separates models-only 429 from actual
inference 429 and proves automatic retry, stale-probe rejection, completed
inference recovery, no throttling-driven wake and concurrent cooldown coalescing.
`test/responses.test.mjs` covers pure mappings, malformed and split SSE, tools,
usage, limits, refusal and incomplete responses. `test/panel-responses.test.mjs`
proves authentication/CORS, actual upstream path, overrides, accounting, retries,
errors and disconnect behavior over HTTP.

Codex regression fixtures must use a strict Chat-only worker that rejects
Responses-only root fields. Cover full-history two-turn namespace/function/custom
calls, custom SSE, original usage/log routes, direct Chat metadata stripping and
safe error diagnostics. A permissive mock that only checks the upstream URL
cannot prove compatibility. `scripts/smoke-codex.mjs <codex.js>` runs an installed
Codex CLI with temporary `CODEX_HOME`, dummy keys, hosted search disabled and a
strict loopback Chat worker. It validates real tool execution and the second
history request without reading production configuration or credentials.

## Wrong vs Correct

Wrong: `catch { fail(account.id, "connection timeout") }` after any inference error.
Correct: reject stale results, confirm authenticated workspace reachability and
apply the correct connection or upstream cooldown category.

Wrong: count converted Responses input tokens with Anthropic cache semantics.
Correct: capture the raw upstream Chat usage once before conversion.
