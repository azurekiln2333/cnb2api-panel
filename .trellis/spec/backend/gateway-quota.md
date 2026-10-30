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

## 8. Automatic quota protection

Apply this contract to account eligibility, background quota synchronization,
settings persistence and the console's quota state.

`settings.quotaProtection` is `{ enabled: boolean, thresholdPercent: integer }`.
Default to enabled with a ten-percent threshold, including legacy stores.
Accept thresholds from 1 through 100 and preserve omitted fields on updates.
`account.quotaProtection` is derived runtime state:
`{ suspended, reason, remainingPercent, thresholdPercent }`. Its reason is
`disabled`, `unknown`, `sync-error`, `invalid`, `low` or null. Keep this state in
stats.json and recompute it after loading or committing account/settings state.

Deduct both used and frozen credits. Suspend when remaining percentage is
strictly below the threshold. Exactly ten percent is eligible under the default
policy. Allow only bounded floating-point roundoff in percentage comparisons;
3 total minus 2.7 used must remain eligible, while 9.9999999999 percent must not.
Unknown, malformed, mismatched-organization or failed quota reads fail
closed. Validate the total allowance and used Credits before normalization so
missing values cannot become invented zero balances. CNB's public Swagger
`dto.VolumeUsedResp` does not require `freeze_credit_in_milli`. Accept an omitted
frozen-usage field as zero when the total and used values are valid. Reject an
explicit null, negative, nonfinite or otherwise malformed frozen value. Preserve
nonzero frozen usage in the remaining-balance calculation. Explicit zero and
numeric strings are valid upstream values. Retain a previous snapshot for
display after errors, but do not use it to authorize routing. A retry marked
syncing carries previousStatus; only prior ok verification may remain eligible.
Retain the preceding error/unverified state until a successful read.
Capture previousStatus separately for each organization sibling. Copying the
source account's ok state must not re-enable a sibling with rotated credentials.

Keep suspension independent of account.enabled, health and real HTTP cooldown.
Never change a user's manual enablement to implement protection. Continue quota
polling while suspended and automatically clear suspension after an authoritative
snapshot reaches the threshold, including a new quota cycle. A manually disabled
account stays disabled. The console displays quota suspension distinctly from
offline/cooling states and explains automatic recovery.
Apply suspension to new requests and leave admitted requests running. Model
eligibility and session affinity use the same protection guard. Never synthesize
upstream HTTP 429 from quota protection. A probe cannot clear quota suspension.

| Condition | Routing protection |
| --- | --- |
| Valid 9% remaining with threshold 10 | Suspend |
| Valid 10% remaining with threshold 10 | Clear quota suspension |
| New quota period restores balance | Resume after successful sync |
| Sync error or retry after an error | Suspend until verified success |
| Unknown, invalid or wrong-organization quota | Suspend |
| Policy disabled | Do not suspend for quota |
| User manually disabled account | Never auto-enable |
| Threshold not an integer in 1..100 | Reject settings update |

Good: a low-quota account keeps polling and resumes on quota reset without a
browser. Base: existing installations receive the enabled ten-percent policy.
Bad: set enabled=false on low balance or reuse an old snapshot during a failed
sync retry, which respectively loses manual intent or permits unverified routing.

`test/panel-quota-protection.test.mjs` must prove routing exclusion and recovery,
the exact threshold, frozen credits, shared organizations, synchronization errors,
manual disablement, policy changes, migration and storage partitioning.
`test/quota.test.mjs` rejects missing/invalid required credit fields and verifies
the omitted-frozen-usage case against CNB's documented response shape. HTTP
integration tests must prove that this response restores all organization
siblings after a failed sync. Browser
tests verify the pause/recovery state and protection settings through real APIs.
Unrelated inference test fixtures explicitly disable quota protection rather
than weakening its production default or inventing successful quota snapshots.

## 9. Quota synchronization diagnostics

The management request passes through the panel before it reaches CNB. A 502 on
`POST /api/accounts/:id/quota` is not evidence that CNB returned HTTP 502 or that
Cloudflare caused the failure. Upstream HTTP failures, network failures, invalid
JSON and invalid credit values can all fail the panel operation. A proxy error
page cannot establish whether the panel finished its upstream query.

Classify failures at the quota-fetch boundary. Preserve the upstream resource
(`quota` or `volume`) and actual HTTP status for safe diagnostics and the existing
401/403 sibling-token fallback. Return fixed, credential-free messages for HTTP,
timeout, transport, JSON and validation failures. Store that same safe message in
`quotaSync.error` so an administrator can inspect it after a proxy replaces or
loses the operation response. Never persist raw upstream bodies, arbitrary
exception messages, tokens or network causes in account state or API errors.

Keep management errors separate from inference health and cooldown. A quota
read returning HTTP 429 must not become an inference 429 or mark workspaces
offline. Continue the existing retry and verified-recovery policy.
