# Account and request-log controls

## Scope / Trigger

Use these contracts when editing account bulk actions, quota summaries or
ActivityView filters and export. State must describe the operation it controls.

## Signatures

- `AccountsView.probeAll()`: probe enabled accounts with endpoints that are not
  already busy, using dedicated batch state.
- `formatRemainingQuotaPercent({ total, used, freeze })`: remaining quota label.
- `ActivityView`: request outcome filter and export of its filtered collection.

## Contracts

Disable bulk probing only for an active batch or an empty candidate list.
Polling and an unrelated account operation must not disable the whole button.
Keep per-account busy checks and release batch state in `finally`.

Remaining quota equals `max(0, total - used - freeze)`. Percentage uses the same
numerator and total, clamps to 0..100 and shows at most one decimal. Missing or
nonpositive totals show `—`. Aggregate by organization before calculating the
percentage so shared organization accounts do not multiply the total.

Request logs offer all/success/failure outcomes. Send the outcome, search and
other active filters to the server before pagination. Fetch 20 rows per page and
derive page counts from the returned total. Export through the authenticated
download endpoint so it includes matches on all pages without exceeding the
frontend JSON reader limit. Preserve audit/system event-type filters. Do not
fetch raw request bodies for export.

## Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Another account is busy | Remaining probe candidates stay actionable |
| Batch settles, including failed actions | Batch button becomes actionable again |
| Full remaining quota, 7166 of 7166 | Display 100% |
| Missing/zero quota total | Display unknown percentage |
| Request status below 400 and at least 200 | Success filter |
| Request status 400 or higher, including 499 | Failure filter |
| Empty filtered result | No mismatching rows in export |

## Good / Base / Bad Cases

Good: a slow account probe does not block starting probes for other accounts.
Base: no outcome/search restriction exports all retained request records.
Bad: export only the current 20-row page or leave the request filter showing
only the redundant API-request event category.

## Tests Required

Browser checks hold one account probe pending, verify the bulk button remains
available and verify batch settlement. Exercise quota refresh percentages.
Create more than one page of mixed-status logs, combine search and outcome,
download export and assert exact matching IDs/counts. Verify channel isolation.

## Wrong vs Correct

Wrong: `disabled = loading || busy.size > 0` for every account action.
Correct: derive enabled state from actual candidates and dedicated batch state.

Wrong: serialize paginated `rows` for export.
Correct: download the server's complete filtered collection.
