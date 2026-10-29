# Registration relay

## Scope and entry points

Apply this contract to the registration-only fanout between independent panels.
The primary updates its local workspace endpoint and asynchronously posts it to
configured peers. An external load balancer distributes inference traffic.

- `settings.registrationRelay`: `{ enabled, servers: [{ id, name, origin, enabled }] }`.
- `GET /api/registration-relay`: authenticated, bounded per-server runtime DTO.
- `POST /api/registration-relay/sync`: authenticated manual scheduling/retry.
- `RegistrationRelay.register(id, endpoint, metadata)`: atomically update the
  endpoint plus outgoing jobs or incoming receipt, returning `{ applied, result }`.
- `RegistrationRelay.reconcile()/sync()/status()/start()/stop()/kick()` manage
  durable work, lifecycle and status independently of the browser.

## Authentication and domain validation

Use the existing `X-Reg-Token` to match a pre-existing account at each peer's
`/ops/register`. Never forward the primary's local account-ID route suffix;
matching accounts on independent panels have different UUIDs. Peers also need
the correct local workspace PROXY_KEY. Registration does not provision accounts.

Peer settings contain only non-secret names, origins and switches. Ordinary
panel domains need a separate canonical HTTPS-origin validator. Do not reuse
`normalizeEndpoint`, which deliberately accepts CNB workspace hosts only.
Reject credentials, paths, queries, fragments, duplicate origins and known
self-origins. Loopback HTTP requires the existing explicit local capability.
Bound the server list to twenty entries and reject redirects before sending
credentials to another destination.

## Persistence and delivery

Persist the local registration update and latest outgoing deliveries in one
Store commit before acknowledging the original CNB request. Preserve the
original `{ ok: true, accountId }` response. Pool records and probes only an
applied update; peer failures never turn a committed registration into a CNB
failure.

Keep relay runtime in stats.json and configuration in panel.json. Store only
references, endpoint/revision information, bounded safe outcomes and retry
timestamps in delivery records. Read registration credentials from the existing
encrypted account secrets at send time. Never copy plaintext tokens into runtime,
settings, audit logs or delivery status. Use the existing recoverable file
journal, including legacy-store defaults.

Keep at most the latest job per account/peer. Bound concurrent delivery to four,
serialize each pair, use a ten-second total fetch/body deadline and bounded
acknowledgement parsing. Back off automatic retries from five seconds to a
five-minute ceiling. Resume persisted work at startup and stop timers/fetches
on shutdown. Work must not depend on a browser remaining open.

Recheck account/endpoint/credential generation and peer identity/origin before
dispatch and completion. Old results must not acknowledge replacement jobs.
Disabled peers or disabled relay stop delivery. Peer additions/enabling and
manual sync schedule existing current endpoints. Disabled source accounts may
still update addresses; each receiver independently controls routing eligibility.
Persist the paused boundary on existing jobs. Re-enabling replaces paused jobs
with an immediate attempt rather than retaining the old retry deadline.

## Single-hop and ordering

Use a versioned relay envelope with a stable source instance ID and monotonic
revision. Ordinary registration-token authentication remains mandatory. Invalid
or partial envelopes fail before mutation. Receivers persist an incoming cursor
with the endpoint and skip fanout for all relayed registrations, including
background reconciliation. Repeated or lower revisions are idempotent and must
not reset a newer endpoint or probe.
Reject a relay whose source UUID matches the local runtime UUID, including case
variants, before mutating the endpoint, receipt or outgoing deliveries. This
also protects against a self-target alias when publicUrl is not configured.

Verify structured protocol acknowledgements. Older peers that ignore ordering
metadata must report an unsupported-version outcome instead of being presented
as safely synchronized. All linked panels should run the feature release.
Automatic primary election and multi-primary conflict resolution are outside
this contract.

## Runtime visibility and errors

Keep status outside editable settings. Expose configured server identity,
enabled state, pending/failed counts, last attempt/success and a safe error.
Record delivery outcomes in the system log with static messages. Audit manual
sync. Never retain raw peer bodies, arbitrary fetch errors or request headers.

| Case | Expected behavior |
| --- | --- |
| Relay disabled | Existing registration contract, no fanout |
| Invalid token/URI | Reject before local mutation or queueing |
| Unknown peer account/token | Safe authentication failure and retry visibility |
| Stalled peer/body | Bounded failure, local acknowledgement already succeeds |
| A and B target each other | Relayed update stops after one hop |
| Older/duplicate revision | Idempotent acknowledgement, no endpoint reset |
| Local source UUID or alias targeting self | Safe 400, preserve endpoint/outbox |
| Re-enable peer or outgoing switch | Immediate current delivery, discard old delay |
| Process restart | Resume current persisted pending work |
| Deleted account/peer or obsolete generation | Prune or replace; ignore old completion |

## Required verification

Use multiple real temporary panels with different account IDs and synthetic
matching tokens, plus strict peers for malformed acknowledgements, redirects
and stalled bodies. Cover atomic persistence, old-store defaults, concurrency,
backoff/restart, stale generation/receipt protection, configuration/account
changes, authenticated management endpoints, manual-operation audit and token
exclusion. Avoid tests that only assert a fetch was attempted.

## Good, base and bad cases

- Good: independent panels use different account UUIDs and the same REG_TOKEN;
  all enabled peers acknowledge the current URI and matching relay revision.
- Base: absent legacy relay settings load disabled; ordinary registration keeps
  the original response and local probing behavior.
- Bad: a peer returns 200 headers and stalls its body. The delivery times out
  within the same total deadline and leaves a safe retryable status.

## Wrong versus correct

Wrong: forward `/ops/register/<primary account UUID>` and wait before replying to
CNB. The peer can have another account UUID and can be unavailable.

Correct: atomically commit local registration and the outbox, acknowledge CNB,
then post to each peer's token-matched `/ops/register` in the background.
