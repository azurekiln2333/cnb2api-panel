# Model-list page

## 1. Scope and trigger

The `models` navigation page displays current panel inventory and helps copy
model IDs into clients. It does not assert that discovered models passed inference.

## 2. Signatures

- `ModelsView.vue` loads authenticated `GET /api/models` using existing `api()`.
- `Page` includes `models`; desktop, collapsed and mobile navigation share it.
- The page uses existing clipboard and notification helpers.

## 3. Contracts

Use the model DTO from `backend/model-inventory.md`. Display IDs, configured
versus discovered sources, public listing, eligible account counts and names.
Search IDs and account names without mutating server state. Copy the exact ID.
The current route-ready count is not an inference-validation count.

Load data independently of session startup and logs. Ignore responses after
unmount or session expiration. Stop polling when hidden or unmounted and retain
usable navigation if requests fail. Reuse global session-expired handling.

The New API access hint selects OpenAI channel type with the panel root URL and
gateway key. Models use `/v1/models`; native credits use `/v1/quota`. Legacy
billing compatibility mirrors CNB-credit numbers, not actual USD conversion.

## 4. Validation and error matrix

| Condition | UI behavior |
| --- | --- |
| No known models | Explain discovery/configured scope without fabricated IDs |
| Search has no matches | Clear search or change query |
| Read failure | Local error with retry and usable navigation |
| Background 401 | Existing login/session-expired path |
| Delayed previous-page response | Ignore it |
| Narrow screen or long model ID | Keep copy/search/navigation reachable |

## 5. Good, base and bad cases

- Good: a searched ID shows both source types and currently eligible accounts.
- Base: an empty inventory gives a useful empty state.
- Bad: a configured-only model must not be labeled as upstream-verified.

## 6. Required tests

Cover navigation, search, exact ID copy, source/status rendering, empty/error
states and mobile layout. Verify no log fetch occurs on page startup and no
stale read updates an unmounted view.

## 7. Wrong versus correct

Wrong: show a static vendor catalog as guaranteed supported models.

Correct: label actual panel observations and routing scope independently.
