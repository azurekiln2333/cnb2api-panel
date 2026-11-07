# Token usage and cache coverage

## Scope / Trigger

Apply this contract to provider parsing, protocol conversion, retry accounting,
worker comparisons, and token/credit display. The cnb2api worker deploys
independently. Updating the panel cannot repair an old worker's discarded data.

## Signatures

- Panel `UsageMeasurement.accept(envelope)` / `.value()` serve both
  `TokenUsageCapture` and Responses output.
- `TokenUsageCapture.finish(bodyComplete, { partial })` separates received JSON
  completeness from downstream conversion success.
- `deriveCacheMiss(tokenUsage)` returns a compatible measured-population miss or
  `null`.
- Request records add bounded `usageAttempts: [{ accountId, tokenUsage }]`.
  `tokenUsage` remains the aggregate for the user request.
- Worker authenticated `GET /usage` adds schema 2:

```json
{
  "schema_version": 2,
  "capabilities": {"cache_hit": true, "cache_miss": true, "cache_write": true, "credit": true},
  "boot_id": "example-boot",
  "booted_at": "2026-11-06T00:00:00.000Z",
  "totals": {"prompt": 4007, "completion": 100, "requests": 1, "errors": 0, "partial_requests": 0, "cache_hit": 3840, "cache_miss": 167, "cache_write": 0, "credit": 0.0125},
  "coverage": {"prompt": 1, "completion": 1, "cache_hit": 1, "cache_miss": 1, "cache_write": 0, "credit": 1}
}
```

## Contracts

Internal input includes cache tokens. Chat `prompt_tokens` already includes
them. Messages `input_tokens` excludes cache reads/writes, so convert exactly
once. Mixed envelopes preserve the measured primary family. Zero-only Chat
placeholders may defer to measured Messages counters. Billing-only cache events
must not change an established primary input family.

Recognized aliases of one cache counter merge by maximum. Repeated cumulative
stream blocks also merge by maximum. Never add aliases or replace the entire
measurement with the final block. Preserve zero separately from absence. Ignore
estimated usage and invalid counters. Token counters are nonnegative safe
integers. Credits are nonnegative finite numbers and may be fractional.

The worker always requests `stream_options.include_usage=true` at its provider
boundary, including non-streaming clients and Messages conversion. Preserve
other options. Native Chat streams remain transparent. Buffered Chat and
Messages use shared worker capture. Messages start placeholders carry
`usage_estimated: true`; terminal usage emits measured input/cache fields.
Missing terminal usage remains estimated.

The Responses wire format retains its established numeric detail defaults:
an omitted cache field becomes `input_tokens_details.cached_tokens: 0` there.
That compatibility value is not evidence of measured zero. Panel accounting
must capture raw upstream usage before conversion and preserve missing coverage.
Do not use converted Responses output to audit upstream cache coverage.

Worker `totals.requests` counts provider attempts, including errors and
interruptions. Each `coverage` field counts attempts measuring that field.
`totals.partial_requests` counts interrupted attempt measurements independently
of coverage and errors. Preserve received counters when an attempt is aborted.
A canceled client does not have to increment errors. A partial count above zero,
or a legacy snapshot without that counter, cannot prove complete coverage for
hit rates or credit density. The monitor exposes it as `upstream.partialRequests`.
Capabilities identify implemented fields, not provider coverage. Worker
`cache_miss` is explicit upstream telemetry only. Never derive it in snapshots.
`credit` is only a measured provider value, never a guessed token price.

Panel `reportedRequests + missingRequests` counts eligible inference attempts,
not user requests. Existing request counts retain their meaning. Record usage
before changing accounts. Global/hourly totals add the aggregate once. Each
account adds only its own ledger entries. Legacy records without a ledger keep
single-account behavior. Fully received JSON usage survives conversion failure;
failure/partial flags remain independent. Do not estimate unreported charges.

Derive local cache miss only when every attempt has input/output and cache-read
coverage, without missing or partial usage. Ratios need the same fully covered
population. Partial subtotals do not justify a full hit rate or credit density.
Raw prompts and credentials never enter usage evidence.

Worker comparisons are diagnostic. Never add snapshot deltas to local request
totals. Reset diagnostic baselines on boot, connection, schema, capability, or
counter regression. Preserve historical statistics. Missing legacy cache/credit
fields are unknown. Positive legacy subtotals may remain visible with unknown
coverage. Old zero counters do not become measured zeros after upgrade.

## Validation & Error Matrix

| Input or event | Required behavior |
| --- | --- |
| Chat input 4007, cached 3840, another cache alias 0 | Input 4007, cache 3840 |
| Chat zeros plus Messages input 167/cache 3840 | Inclusive input 4007 |
| Billing-only cache before/after primary Chat | No double-counted input |
| Input/cache block then output-only block | Retain measured fields |
| Omitted cache or credit | Unknown diagnostic/display value |
| Explicit measured zero | Zero with coverage |
| Estimated usage | Missing, not a measured free call |
| Complete JSON fails conversion and retries | Preserve and attribute both attempts |
| Partial coverage | Mark subtotal; suppress unsupported ratios |
| Invalid schema 2 coverage | Reject snapshot; retain last valid state |
| Worker/schema change | Reset diagnostics, preserve lifetime totals |

## Good / Base / Bad Cases

Good: cached 3840 survives a later output-only block through worker and panel.
Base: input/output exist but cache is omitted; display an em dash for cache.
Bad: test only an ideal mock worker while the real adapter discards fields, or
assume a panel release upgrades worker runtime sources.

## Tests Required

- Parser and Responses tests: both placeholder families, cache-only usage,
  split/late blocks, billing event order, alias conflicts, estimated/invalid
  counters, and inclusive-input invariants.
- Retry tests must actually select two accounts. Verify failed-conversion JSON,
  coverage, account/global/hourly totals, and reload persistence. A streaming
  abort after headers is not a retry test.
- Worker tests cover usage options, transparent Chat SSE, buffered split usage,
  Messages JSON/SSE, and interrupted measurements.
- Comparison/browser tests cover unknown vs zero, partial/legacy positive
  values, absent credit, mixed workers, capability changes, and conservative
  ratios. Type-check nullable values throughout the frontend.
- Run `node scripts/verify-worker-usage.mjs ../cnb2api` against an actual worker
  and panel with a loopback provider. The path is explicit; normal panel tests
  do not depend on a sibling checkout.

## Wrong vs Correct

Wrong: choose the first numeric cache alias and display cache whenever any usage
exists. Correct: merge aliases and carry field-specific reporting coverage.

Wrong: infer provider cache misses or credit loss from synthetic tests alone.
Correct: identify the deployed worker and compare measured cache, credits,
attempt coverage, and organization quota over the same interval.
