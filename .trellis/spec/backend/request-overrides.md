# Request Overrides

## Scope / Trigger

Apply this contract when changing Chat Completions or Messages rewrites,
management overrides, workspace header propagation or request diagnostics.

## Signatures

- Authenticated `PATCH /api/settings`: `dshCompat`, `claudeCodeCompat`,
  `requestOverrides.operations`, and `upstreamHeaders`.
- Authenticated `GET /api/logs/requests/:id`: one request log with diagnostics.
- Panel-generated `x-cnb2api-upstream-headers`: base64url JSON of allowlisted
  names and values. `x-cnb2api-override-support: 1` confirms carrier support.

## Contracts

The enabled compatibility preset converts all Chat Completions `developer`
roles to `system`. For identified DSH requests, it neutralizes selected
system/developer identity text, brand and one reported path sentence pair.
It replaces two exact DSH identity patterns in assistant history.
It never changes user or tool text. Role conversion changes instruction priority.
The separate `claudeCodeCompat` preset applies to native `/v1/messages` and to
`/v1/chat/completions`, including Chat payloads the Responses bridge builds.
New API converts native Messages into Chat, so the same fingerprints arrive on
the Chat route. On Messages it rewrites three Claude Code fingerprints in the
root system text, in system blocks and in tool descriptions. On Chat it rewrites
the same fingerprints in `system` and `developer` message content, both string
and `text`/`input_text` parts, and in `tools[].function.description`. Billing
values and URLs survive. It never rewrites user, assistant or tool message text
on the Chat route and never rewrites tool-result or assistant tool-input text on
Messages. It also drops the root `thinking` toggle. `Pool.forward` strips every
thinking toggle from the final Chat payload for each route and records a
`thinking_toggle` diagnostic. Both text rules report as `claude_code_text` and
the field rule as `claude_code_fields`. The DSH preset keeps its three rules,
outcomes and order unchanged; the Claude Code entries follow them.
Apply custom rules after both presets; preserve original input for session affinity.
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
Replay the three Claude Code fingerprints on both routes: Messages root system,
system blocks and tool descriptions, plus Chat system and developer content with
string and block content and `function` tool descriptions. Prove that Chat user,
assistant and tool text and Messages tool results keep their original bytes,
that a DSH-only request is unchanged with the preset on, and that
`claudeCodeCompat=false` leaves both routes untouched. Cover regex syntax,
order, size bounds, protected headers, retries, stream and
non-stream paths, persistence, management authorization, and privacy. Exercise
the workspace carrier against a local mock provider and separately verify live
deployment before claiming end-to-end support.

## Wrong vs Correct

Wrong: replace only `messages.0` and assume the workspace forwards headers.
Correct: inspect all relevant roles and prove each hop with an acknowledgement
and a mock-provider assertion, while leaving real payload text out of logs.
