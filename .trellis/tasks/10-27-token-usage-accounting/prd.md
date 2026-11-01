# Fix Token Usage Accounting

## Goal

Show trustworthy input, output, cache, and total Token usage for gateway
requests, and clearly identify data that the upstream did not report.

## Confirmed Facts

- The user reports 2,833 partial and 363 missing usage records, with all values
  at zero. The deployed worker and raw response data have not been verified.
- The panel parses OpenAI and Anthropic JSON/SSE usage and requests OpenAI
  stream usage (`src/token-usage.mjs:24`, `src/pool.mjs:698`).
- The local worker's Messages stream starts with zero input/output and sends
  only output usage at the end. Non-streaming conversion can discard the
  estimated-usage marker (`../cnb2api-main/src/anthropic.mjs:234`).
- A Responses completed event has a distinct nested usage shape. The current
  parser needs an explicit protocol contract to avoid double-counting cache.
- Local worker `/usage` totals can include direct and concurrent requests, so
  their differences cannot reliably establish per-request usage
  (`.trellis/spec/backend/routing.md`).

## Requirements

- Diagnose actual response formats and correct the gateway parsing or routing
  path where trustworthy usage is available.
- Cover all three approved protocol formats and streaming modes.
- Distinguish measured, missing, partial, estimated, and real zero values.
- Preserve accounting across restart and retain existing user data.
- Do not invent or reconstruct precise historical values without evidence.

## Acceptance Criteria

- [ ] Measured input, output, cache, and totals match representative upstream
      JSON and SSE fixtures without double counting.
- [ ] Placeholder and missing usage do not appear as fully measured usage.
- [ ] User-visible totals clearly indicate uncertainty instead of showing a
      misleading exact zero when values are unknown.
- [ ] Usage tests cover cancellation, errors, streaming, and each protocol.
- [ ] Deployed-system verification is documented or its blocker is stated.

## Open Decisions

- What non-sensitive deployed response sample or live verification method is
  available to confirm the source of the reported zero totals?
- Should any separately labeled estimation be offered when real usage is not
  returned, or should the panel report only measured values?
