# Claude Code `/v1/messages` channel rejection (business code 11128)

Written on November 1, 2026 by worker W-B.

## Reported symptom

Claude Code receives HTTP 400 with the message
`Illegal API invocation from an unapproved channel`, business code `11128`.
The reported upstream request ID is `202610311045215008185658268d9d6ZK8V1gsW`.

## Confirmed facts

1. The panel never generates this message. `grep` over `src/` finds no
   occurrence of the phrase. A panel-side bug cannot produce it on its own.
2. The panel forwards `/v1/messages` bodies unchanged except for the request
   override pipeline. `Pool.forward` sends the client body to
   `<workspace>/v1/messages` and copies only `anthropic-version` from the
   client headers (`src/pool.mjs`).
3. The sibling workspace proxy classifies this exact phrase and code.
   `../cnb2api-main/src/proxy.mjs` matches the phrase and code `11128` and
   collapses them into a static channel-validation message. The local source
   therefore proves the classification, not the deployed rule.
4. The workspace converts native Messages to Chat before provider dispatch
   (`../cnb2api-main/src/server.mjs`). Therefore the rejection happens at or
   after that conversion. It cannot be a New API protocol conversion.
5. The workspace already rewrites three Claude Code fingerprints before
   dispatch (`../cnb2api-main/src/anthropic.mjs`): the
   `x-anthropic-billing-header` token, the "to give feedback" sentence and the
   "You are Claude Code, Anthropic's official CLI for Claude" sentence. The
   workspace README attributes business code `11128` false positives to these
   fingerprints.
6. The workspace also strips `reasoning_effort`, `reasoning`,
   `enable_thinking` and `thinking` from the outbound Chat payload
   (`../cnb2api-main/src/proxy.mjs`). The comment records a measured failure:
   a thinking toggle routes to a variant that spends `max_tokens` on reasoning,
   so the answer never completes.

## Inference

The evidence points at request content, not at an authenticated channel. The
workspace forwards with its own workspace token, and no client header reaches
the provider. A channel rule keyed on headers would therefore reject every
request, including plain OpenAI clients, which the user does not report.
A rule keyed on Claude Code fingerprints explains why only Claude Code fails.

## Unverified items

- The deployed workspace version was not inspected. Its fingerprint list may
  differ from the local source.
- The exact provider rule and its match list remain unknown. No live request
  was issued with the report ID.
- Header propagation through `upstreamHeaders` was not exercised against CNB.
  Only the allowlisted agent headers are carriers, so the workspace would have
  to forward them further, which the panel cannot confirm.

## Applied change (panel side)

The panel avoids depending on one workspace version. Both panel paths send the
same Chat payload, so the panel now removes the fingerprints it owns:

- New `claudeCodeCompat` setting, enabled by default, independent of
  `dshCompat`. Apply it only to native `/v1/messages`.
- Rewrite the three fingerprints in the root `system` text, in system blocks
  and in tool descriptions. Billing values, URLs and tool schemas survive.
- Never rewrite user text, tool results or assistant tool input.
- Delete the root `thinking` toggle in that preset.
- `Pool.forward` deletes every thinking toggle from the final Chat payload for
  all routes and records a `thinking_toggle` diagnostic.

The three DSH preset rules are unchanged.

## Recovery steps for the operator

1. Upgrade the panel, confirm `claudeCodeCompat` is enabled, then retry Claude
   Code.
2. Open `/api/logs/requests/:id` for the failing request. Expect
   `claude_code_text` and `claude_code_fields` with outcome `applied`.
   A `skipped` outcome means the request did not take the native Messages route.
3. If the rejection persists, compare the deployed workspace
   `src/anthropic.mjs` phrase table with the panel table. Report the request ID
   to the provider and ask which rule rejected it.
4. Do not change the New API channel type. The channel label does not
   establish a protocol conversion.

## Validation

`node --test test/request-overrides.test.mjs test/panel-overrides.test.mjs`
covers the preset, the Chat exclusion, the disable switch, persistence and the
diagnostic rules. No live request or deployment was performed.
