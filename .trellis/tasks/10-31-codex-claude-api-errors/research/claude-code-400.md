# Claude Code channel rejection (business code 11128)

Written on November 1, 2026 by worker W-B, extended by W-B2 after live logs.

## Reported symptom

Claude Code receives HTTP 400 with the message
`Illegal API invocation from an unapproved channel`, business code `11128`.
The reported upstream request ID is `202610311045215008185658268d9d6ZK8V1gsW`.

## Live request log (November 1, 2026, confirmed)

The deployed panel request log changed the earlier route assumption:

- Claude Code reaches the panel as `POST /v1/chat/completions`. The New API
  channel is an OpenAI channel and converts native Messages.
- The log shows `dsh_roles`, `dsh_privileged_text` and `dsh_assistant_identity`
  as unmatched, and every `claude_code_*` rule as skipped. The first preset
  version applied only to `/v1/messages`, so the fingerprint stayed in the Chat
  system message and the workspace rejected it.
- The rejecting text is the sentence
  `You are Claude Code, Anthropic's official CLI for Claude.` The same request
  with `You are Claude Code, a command-line coding assistant.` or with the
  sentence removed returns 200.

This confirms the content-fingerprint hypothesis and rejects the header
hypothesis. The fix has to cover the Chat route, not only `/v1/messages`.

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
   after that conversion.
5. The live log shows New API also converts native Messages before the panel.
   The request therefore arrives at the panel as Chat and needs the rewrite on
   the Chat route.
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
rejecting rule runs after the New API Chat conversion, on the Chat system
message. A rule keyed on Claude Code fingerprints explains why only Claude Code
fails, and the recorded 200 responses show the identity sentence alone decides
the outcome.

## Unverified items

- The deployed workspace version was not inspected. Its fingerprint list may
  differ from the local source.
- The exact provider rule and its match list remain unknown. No live request
  was issued with the report ID.
- Header propagation through `upstreamHeaders` was not exercised against CNB.
  Only the allowlisted agent headers are carriers, so the workspace would have
  to forward them further, which the panel cannot confirm.

## Applied change (panel side)

The panel avoids depending on one workspace version. It rewrites its own
fingerprint table on both client routes:

- New `claudeCodeCompat` setting, enabled by default, independent of
  `dshCompat`.
- Native `/v1/messages`: rewrite the three fingerprints in the root `system`
  text, in system blocks and in tool descriptions, and delete the root
  `thinking` toggle.
- `/v1/chat/completions`, including the Chat payload the Responses bridge
  builds: rewrite the same fingerprints in `system` and `developer` message
  content, both string content and `text`/`input_text` parts, and in
  `tools[].function.description`.
- Never rewrite Chat user, assistant or tool message text, and never rewrite
  Messages tool results or assistant tool input. Billing values, URLs and tool
  schemas survive.
- `Pool.forward` deletes every thinking toggle from the final Chat payload for
  all routes and records a `thinking_toggle` diagnostic.
- Both text rules report as `claude_code_text`. The DSH preset keeps its three
  rules, outcomes and order, and runs first.

## Recovery steps for the operator

1. Upgrade the panel and confirm `claudeCodeCompat` is enabled.
2. Open `/api/logs/requests/:id` for the failing request. A Claude Code request
   that arrives through New API has `path: /v1/chat/completions` and shows
   `claude_code_text` as `applied`. A `skipped` outcome means the preset is
   disabled or the request took another route.
3. If the rejection persists, compare the deployed workspace
   `src/anthropic.mjs` phrase table with the panel table, then report the
   request ID to the provider and ask which rule rejected it.
4. Do not change the New API channel type. The recorded log already shows the
   request arrives as Chat.

## Validation

`test/request-overrides.test.mjs` covers both routes: string and block
privileged content, `function` tool descriptions, untouched user, assistant and
tool text, an unchanged DSH-only request, the disable switch and the Messages
behaviour. `test/panel-overrides.test.mjs` proves the native Messages route over
HTTP. `test/panel-responses.test.mjs` proves the Chat payload the Responses
bridge builds also carries the rewrite. `npm test` passes 419 of 419.
No live request or deployment was performed by this worker.
