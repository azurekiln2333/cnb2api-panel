# New API quota contract evidence

Inspected local New API source on 2026-10-29 without reading credentials or
production data. Upstream repository:
<https://github.com/QuantumNous/new-api>.

`D:/My2KProjects/new-api/controller/channel-billing.go:620` selects the balance
adapter by channel type. The OpenAI branch honors the configured base URL.
At line 662 it requests `GET <base>/v1/dashboard/billing/subscription` with the
channel bearer key. At line 679 it requests
`GET <base>/v1/dashboard/billing/usage?start_date=...&end_date=...`.
At line 689 its balance is `subscription.HardLimitUSD - usage.TotalUsage/100`.

The panel is an OpenAI-compatible gateway, not a New API user-account service.
Configure an OpenAI channel and a root URL without `/v1`. Existing `/v1/models`
supports model pulling. Do not fabricate New API's `/api/user/self` contract.

The panel's quota source uses CNB Credits, not USD. Mirror credit numbers in
legacy field names and explain the unit on the access page and README. Native
`/v1/quota` reports explicit native totals. Legacy usage includes frozen credits
so the subtraction reflects available quota. Per-organization clamping protects
another organization's balance from an overdrawn organization.

Read cached snapshots only. Existing quota refresh owns credentials and outbound
requests. Refuse missing/incomplete quota instead of returning false zero or
partial balances. Multiple accounts in one organization share the same quota.

Regression assertions must perform the actual two-response New API arithmetic,
test gateway-key authentication on each alias, and verify credential-free native
and compatibility bodies. Date ranges cannot synthesize historical CNB usage.
