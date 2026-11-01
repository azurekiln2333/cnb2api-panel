# Diagnose Codex and Claude Code API errors

## Goal

Explain both reported HTTP 400 errors and provide evidence-backed recovery steps.

## Background

- Codex reports `unsupported_parameter` at `tools.14.type`.
- The error states that the Responses compatibility bridge cannot execute hosted web search.
- Claude Code reports `Illegal API invocation from an unapproved channel`.
- The reported upstream request ID is `202610311045215008185658268d9d6ZK8V1gsW`.
- The user approved creation of this diagnostic task on October 31, 2026.
- The user confirmed the Claude Code New API channel targets this panel.
- The user confirmed that New API preserves native `/v1/messages` requests.
- The New API channel label is OpenAI. It is not evidence of a protocol conversion.

## Requirements

- R1: Identify the Codex rejection source and verify the supported configuration setting.
- R2: Trace Claude Code error propagation and distinguish proven facts from hypotheses.
- R3: Provide actionable recovery steps without exposing credentials.
- R4: Record findings before proposing any configuration or product changes.

## Acceptance Criteria

- AC1: The explanation links the Codex error to repository evidence and official configuration documentation.
- AC2: The Claude Code explanation identifies the evidence needed to confirm the rejecting service.
- AC3: Recovery instructions preserve the user's provider and authentication settings.
- AC4: Any unverified root cause remains explicitly qualified.

## Out of Scope

- Production deployments and live inference requests.
- Credential changes and automatic account switching.
- Implementing hosted web search in the Chat bridge.
- Product code changes before the user approves a concrete implementation scope.

## Diagnostic Status

- The Codex error and recovery setting are confirmed.
- The Claude Code rejection category is confirmed from the reported message.
- The exact live provider rule and deployed workspace version remain unverified.
- Read-only diagnosis is complete for the available local evidence.
- No product implementation or client configuration change has been applied.

## Implementation Scope (approved 2026-11-01)

Goal: Codex (/v1/responses, /v1/chat/completions) and Claude Code (/v1/messages) all work through the panel. DSH compatibility must not regress.

Work split (4 pi workers, shared working tree, NO git commit, touch only owned files):

- W-A (pA) Codex hosted tools: `src/responses.mjs` + `test/responses.test.mjs`. Make hosted `web_search` / `web_search_preview` tools degrade gracefully (drop them, keep function tools, no 400, no remap of tool indexes in other errors). Keep other unsupported fields rejecting as today.
- W-B (pB) Claude Code /v1/messages: trace the "Illegal API invocation from an unapproved channel" (business code 11128) path through `src/pool.mjs` (header build ~1004-1014, 400 handling ~1029-1046) and `../cnb2api-main/src/{proxy,anthropic,server}.mjs`. Find which request attribute CNB treats as channel (headers, UA, system prompt). Fix in the panel only if evidence supports it; otherwise write findings to `research/claude-code-400.md`. Owns `src/pool.mjs` + related tests.
- W-C (pC) DSH guard: audit every DSH code path (grep dsh), add/extend regression tests pinning current DSH behaviour BEFORE A/B land, re-run after. Owns DSH tests only; report any DSH break to main.
- W-D (pD) Endpoint matrix + docs: add mock-upstream tests covering the 3 endpoints (chat/completions, responses, messages) incl. Codex request with a web_search tool; update README Codex section + `.trellis/spec/backend/` accordingly. Start with tests, edit docs last.

Done = `node --test` all green, each worker reports changed files + test output tail to pane w2W:p9 (main).
