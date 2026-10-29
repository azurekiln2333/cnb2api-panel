# Gateway quota for New API

## 1. Scope and trigger

Expose cached CNB organization credits through gateway-key authentication.
Support New API's OpenAI-channel balance reader without sending management or
organization credentials to clients. These numbers represent CNB Credits.

## 2. Signatures

- `GET /v1/quota` returns native credit totals.
- `GET /v1/dashboard/billing/subscription` returns legacy subscription fields.
- `GET /v1/dashboard/billing/usage` returns legacy usage fields.
- Both billing routes also accept their `/dashboard/billing/...` alias.
- Reuse existing gateway-key authentication and CORS behavior.

## 3. Contracts

Native quota fields: `{ object: "quota", unit: "cnb_credits", total, used,
frozen, remaining, organizations, syncedAt }`. `organizations` is a count;
`syncedAt` is the oldest composing snapshot timestamp.

Determine organization scope from enabled accounts' repository organizations.
For each enabled organization, select its newest valid matching-org quota
snapshot across sibling accounts. Disabled siblings may supply a shared snapshot,
but disabled-only organizations contribute nothing. Require finite nonnegative
credit values and a valid synchronization timestamp. Never count one
organization more than once.

Compute each organization's `max(0, total - used - freeze)` before summing
remaining credits. Sum actual total/used/frozen separately for the native DTO.
The legacy subscription `hard_limit_usd` is total credits. Legacy usage
`total_usage` is `(total - remaining) * 100`. This reproduces New API's
`hard_limit_usd - total_usage / 100` balance calculation while keeping an
overdrawn organization from consuming another organization's balance.

The `usd` suffix is required by the legacy schema and does not imply currency
conversion. Include `unit: "cnb_credits"` and explain that New API may still
render a dollar symbol. Date query parameters do not provide historical
accounting; the endpoints always describe the current cached quota cycle.

Read cached data only. Existing synchronization owns upstream requests and PATs.
Do not return organization names, account IDs, raw errors or secrets.

## 4. Validation and error matrix

| Condition | Outcome |
| --- | --- |
| Missing/incorrect gateway key | Existing 401 error |
| Management session without gateway key | No access |
| Any enabled organization lacks a valid snapshot | Safe 503, no partial/zero total |
| No enabled organizations | Safe 503 |
| Any enabled account has no repository organization | Safe 503 instead of partial totals |
| Aggregate overflow/nonfinite data | Safe 503 |
| Exhausted/overdrawn organization | Zero contribution to remaining |
| Query includes date range | Current cached period, no fabricated historical data |

## 5. Good, base and bad cases

- Good: two accounts in one organization share quota 100, used 20 and frozen 5;
  native remaining and New API's subtraction both produce 75, not 150.
- Base: fresh valid cached snapshots return immediately without upstream calls.
- Bad: an unknown quota must return an unavailable error rather than masquerading
  as an exhausted balance.

## 6. Required tests

Cover actual HTTP authentication, aliases, native fields, the exact New API
subtraction, organization deduplication, latest matching snapshot selection,
disabled-only exclusion, frozen credits, per-organization overdraw clamping,
missing/invalid snapshots and safe credential-free responses.

## 7. Wrong versus correct

Wrong: sum each account's quota or claim CNB Credits are USD.

Correct: sum each enabled organization once and document the native unit even
when satisfying legacy field names.
