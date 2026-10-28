# Request Overrides

## Scope / Trigger

Apply this contract when changing Chat Completions rewrites, management
overrides, workspace header propagation or request diagnostics.

## Signatures

- Authenticated `PATCH /api/settings`: `dshCompat`, `requestOverrides.operations`,
  and `upstreamHeaders`.
- Authenticated `GET /api/logs/requests/:id`: one request log with diagnostics.
- Panel-generated `x-cnb2api-upstream-headers`: base64url JSON of allowlisted
  names and values. `x-cnb2api-override-support: 1` confirms carrier support.

## Contracts

The enabled compatibility preset converts all Chat Completions `developer`
roles to `system`. For identified DSH requests, it neutralizes selected
system/developer identity text, brand and one reported path sentence pair.
It replaces two exact DSH identity patterns in assistant history.
It never changes user or tool text. Role conversion changes instruction priority.
Apply custom rules after the preset; preserve original input for session affinity.
Support `set`, `copy`, `delete`, `regex_replace`, and bounded `full`, `prefix`,
or `regex` conditions. A leading `(?i)` maps to case-insensitive matching.
Conditions default to OR, matching New API. Explicit AND requires every
condition. Custom regexes share a per-request execution budget. Skip mutations
that could grow the JSON request beyond the workspace limit.

Only allow explicitly configured non-credential headers. Never accept a carrier
from the public client or override provider authorization and transport headers.
Missing acknowledgement is unconfirmed, not proof that the provider received a
header. A workspace key holder can submit allowed headers directly.

## Validation & Error Matrix

| Case | Behavior |
| --- | --- |
| Invalid rule, regex, path or header | Reject settings with HTTP 400 |
| Missing condition/path or incompatible request type | Record unmatched or skipped |
| Recognized rule with no regex match | Record unmatched, not applied |
| Oversized custom-regex input or timeout | Skip and record the rule |
| Forwarded request exceeds 4 MiB | Return 413 before selecting an account |
| No workspace acknowledgement | Report unconfirmed |
| Non-management request for details | Reject with HTTP 401 |

## Good / Base / Bad Cases

Good: inspect received and forwarded roles plus matching status without storing
message content. Base: no custom rules or headers preserves normal forwarding.
Bad: infer provider header receipt from a panel-only configuration, or rewrite
all assistant/user/tool messages to remove client fingerprints.

## Tests Required

Replay synthetic DSH strings and neutral developer roles at multiple indices.
Cover regex syntax, order, size bounds, protected headers, retries, stream and
non-stream paths, persistence, management authorization, and privacy. Exercise
the workspace carrier against a local mock provider and separately verify live
deployment before claiming end-to-end support.

## Wrong vs Correct

Wrong: replace only `messages.0` and assume the workspace forwards headers.
Correct: inspect all relevant roles and prove each hop with an acknowledgement
and a mock-provider assertion, while leaving real payload text out of logs.
