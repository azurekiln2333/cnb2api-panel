# Management model inventory

## 1. Scope and trigger

Use a read-only authenticated management inventory to explain the panel's known
model IDs. A probe-discovered ID is a catalog observation, not proof of inference.
CodeBuddy's client catalog is not the CNB worker's authorization contract.

## 2. Signatures

- `Pool.models()` derives inventory from current state.
- `GET /api/models` requires the existing management session.
- Existing gateway-key `GET /v1/models` and `/models` keep their public contract.

## 3. Contracts

The management response is `{ models }`. Each model has `id`, `listed`,
`configuredAccounts`, `discoveredAccounts` and `eligibleAccounts`. Account
references contain only `{ id, name }`.

IDs are the sorted deduplicated union of all accounts' configured `models` and
`discoveredModels`, including disabled accounts for diagnosis. `listed` matches
the public endpoint exactly: enabled accounts contribute their nonempty model
allowlist, or their discovered models when the allowlist is empty.

Compute `eligibleAccounts` using `Pool.eligible(id)`, including unrestricted
accounts that may not have discovered the ID. Do not implement another readiness
policy. Configured scope, catalog discovery, public listing and routing readiness
are distinct facts. No model traffic, probes or quota refresh are triggered.

## 4. Validation and error matrix

| Condition | Outcome |
| --- | --- |
| No management session | Existing 401 response |
| Empty account pool | `{ models: [] }` |
| Same ID in multiple sources | One model with each source's account references |
| Disabled-only ID | Visible for diagnosis, not publicly listed by that account |
| Unhealthy/cooling account | Excluded by existing Pool eligibility |

## 5. Good, base and bad cases

- Good: one account configures an ID and another discovers it; the inventory
  exposes both sources and only currently eligible routes.
- Base: no known IDs yields an empty list without a fabricated fallback catalog.
- Bad: a configured ID must not be labeled inference-tested merely because its
  allowlist allows routing.

## 6. Required tests

Cover authentication, source deduplication, public-list parity, disabled and
cooling accounts, offline accounts and unrestricted account eligibility. Assert
no credentials or endpoints are included in management account references.

## 7. Wrong versus correct

Wrong: hardcode CodeBuddy's nine client options as panel-supported models.

Correct: derive observed/configured IDs from panel state and expose routing
eligibility separately from catalog membership.
