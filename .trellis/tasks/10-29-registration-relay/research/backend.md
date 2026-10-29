# Research: Registration relay backend

- Query: Find the smallest registration-only relay across independently deployed panels.
- Scope: internal
- Date: 2026-10-29

## Findings

### Existing contracts and files

- `src/app.mjs:369-391`: `/register`, `/ops/register` and `/ops/register/:id` accept POST, authenticate `x-reg-token`, read at most 4 KiB, then call `pool.register(account.id, input.uri)`. No-ID routes resolve solely by registration token. The optional ID restricts matching to a local account ID.
- `src/pool.mjs:429-453`: `Pool.register()` validates/normalizes URI, durably patches endpoint/runtime state, records a `register` event, launches independent probe and immediately returns `{ ok: true, accountId }`.
- `src/store.mjs:301-329`: `normalizeEndpoint()` accepts only root HTTPS CNB workspace origins (`*.cnb.run` with the required workspace/port shape), or explicit loopback HTTP when `allowLocal=true`. This validator cannot validate ordinary panel domains.
- `src/store.mjs:681-703`: registration tokens are validated as printable ASCII and unique within a panel. Empty token edits retain the previous token.
- `src/store.mjs:738-752`: account creation generates a new local UUID and a registration token when none is supplied. Independently created matching accounts generally have different IDs.
- `src/store.mjs:331-337`: public account projection omits `secrets` and `workerUsage`.
- `src/store.mjs:500-523`: credentials use AES-256-GCM under the local master key.
- `src/store.mjs:525-572`: `accounts.json` stores definitions/encrypted credentials, `stats.json` stores enumerated account runtime fields and aggregate counters, `panel.json` stores settings and encrypted SSO secret. New runtime fields must be included in `RUNTIME_FIELDS`; arbitrary state keys are not persisted automatically.
- `src/app.mjs:620` and `src/app.mjs:722-725`: overview and settings endpoints currently expose `store.state.settings` directly. Settings must not gain plaintext relay credentials without a new sanitization boundary.
- `src/file-storage.mjs:24-30`: storage has an explicit document filename allowlist. A new queue file requires integration with allowed writes and recovery; it cannot be appended ad hoc while claiming atomicity.
- `src/file-storage.mjs:36-37`: storage intent journaling assumes credential-bearing documents are encrypted before they reach this layer.
- `src/audit.mjs:5-6`, `src/audit.mjs:68-87`: management settings actions are already audited with static descriptions. Headers, request bodies and raw upstream messages must not enter audit logs.

### Token matching across panels

The minimum relay can POST `{ uri: normalizedEndpoint }` to `<peer-origin>/ops/register` with the original account's `X-Reg-Token`. It must not forward the primary's `/ops/register/:id` suffix because the peer's UUID can differ.

This uses the existing receiver authentication without sharing panel admin keys, gateway keys, proxy keys or PATs. The peer must already contain an account with the same registration token and the correct workspace proxy key. A missing or mismatched token produces 403 before registration body processing (`src/app.mjs:379-389`).

Automatically provisioning peer accounts is a separate product decision. The registration payload contains only a URI, so forwarding it cannot create a usable gateway account by itself. Provisioning would require another authenticated management contract, explicit field ownership and credential-transfer policy. Do not infer this scope from registration forwarding.

### Background work and retry patterns

- `src/pool.mjs:196-210`: probes, wakes and quota in-flight jobs use process-local Maps.
- `src/pool.mjs:462-466`: quota jobs coalesce identical organization work and remove completed promises in `finally`.
- `src/pool.mjs:576-593`: quota retry outcome and `nextAttemptAt` are persisted on account runtime state, with exponential retry bounded at 15 minutes and static public error text.
- `src/pool.mjs:599-639`: quota cycle rejects overlapping scans and runs bounded groups of three tasks.
- `src/pool.mjs:773-800`: timers start with the pool, run independently from browsers and use `unref()`; `stop()` clears both timers.

There is no general durable queue or relay subsystem today. A fire-and-forget `fetch().catch(...)` alone loses pending deliveries at process restart. The narrow durable design is bounded per-account/per-peer delivery runtime state in `stats.json`, storing only identifiers/version/endpoint/attempt times/status and reading the current registration token from encrypted account secrets when sending. Persist the local endpoint update and pending delivery generation in one Store commit. Per-peer serialization and generation checks must prevent an older completion from acknowledging a newer registration update.

Delivery-failure behavior is not yet approved. Recommended behavior: acknowledge the local durable registration without waiting for peers, retain failed delivery state, retry with bounded concurrency/backoff and let the administrator retry explicitly. An unavailable peer should not make CNB consider an already persisted local registration failed. Confirm this product behavior during planning.

### Transport, loops and stale work

- Existing authenticated workspace fetches set `redirect: "error"` (`src/pool.mjs:336-343`, `src/pool.mjs:675-685`). Relay must keep that policy to avoid forwarding registration secrets to redirect destinations.
- Use a separate panel-origin validator, allowing configured HTTPS origins without credentials, query or fragment; reserve loopback HTTP for the existing test/local capability. Restrict supplied domains before attaching secrets.
- Keep timeouts and response-body reads bounded; accept success only from a valid registration acknowledgement. Do not log raw peer response bodies or fetch errors.
- A one-hop relay marker can tell receiving updated panels to apply the local registration but not fan out again. The existing registration token remains required even when the marker is present. Apply the marker only after normal authentication and validation. Explicitly decide whether an older peer version without the guard is supported.
- Reject obvious duplicate/self targets using canonical origins where the local public origin is known. The one-hop rule remains necessary because aliases and reverse proxies can conceal self-targets.
- For retries, discard work when its account is deleted, its peer is removed/disabled, its registration token changes, or a newer registration generation supersedes the queued endpoint. Runtime outcome writes must re-check the same generation.
- Persist delivery identity/order if the receiver must reject late old updates after timeouts. A primary timestamp/version cannot be assumed globally monotonic across independent senders without an explicit source identity contract.

### Visibility and tests

`store.record({ kind: "register", ... })` already appears in the system channel (`src/file-storage.mjs:17-22`, `src/pool.mjs:444-450`). Relay outcomes can use static messages plus safe account/peer identifiers and HTTP status. Detailed per-peer retry status belongs in a bounded management projection, not arbitrary raw `settings` secrets or request logs.

Useful existing regression coverage:

- `test/panel.test.mjs:253-291`: local account-ID/token matching and rotation.
- `test/panel.test.mjs:298-374`: supplied token persistence, uniqueness and invalid ASCII.
- `test/panel.test.mjs:378-412`: legacy no-ID registration routes distinct tokens to distinct accounts.
- `test/panel.test.mjs:534-574`: token replacement invalidates all registration aliases.
- `test/panel.test.mjs:597-617`: system registration events and credential exclusion.
- `test/panel-quota-refresh.test.mjs`: bounded background concurrency, restart/runtime polling and stale-credential protection patterns.

Required relay tests should run at least two real panel instances with different account IDs but the same REG_TOKEN, plus a strict HTTP peer fixture. Cover disabled mode, local-before-remote acknowledgement, all enabled peers, mismatch 403, redirect refusal, loop prevention, timeout/retry/restart, latest-endpoint coalescing, deleted peers/accounts, credential rotation, bounded safe status responses and no secret/raw-body logging.

## Related Specs

- `.trellis/spec/backend/database-guidelines.md`: file partitions, encrypted credentials and recoverable commits.
- `.trellis/spec/backend/logging-guidelines.md`: system events, safe static diagnostics, management audit and response-size bounds.
- `.trellis/spec/backend/gateway-compatibility.md`: generation/stale-result guards and independent readiness checks.
- `.trellis/spec/backend/deployment.md`: independent panel data directories and cloud release process.

## External References

No external references needed for this repository-contract investigation. Do not infer a distributed-delivery guarantee from the local storage journal.

## Caveats / Not Found

- The final planning review should state that peers are pre-provisioned with matching tokens, registration is acknowledged locally before asynchronous fanout, and failures remain visible/retryable. Automatic account provisioning is outside the proposed minimum scope.
- No native inter-panel relay protocol, peer trust configuration, durable outbox or distributed ordering contract exists.
- Ordinary panel domains require a separate validator; reusing the CNB workspace validator would reject every real peer domain.
- Plaintext new secrets in `settings` would leak through both overview and settings endpoints unless projections change.
- Existing old task directories are unrelated to this planning task and were not changed.
