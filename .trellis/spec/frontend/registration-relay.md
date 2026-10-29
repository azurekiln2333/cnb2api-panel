# Registration relay controls

Keep the registration-relay configuration in the routing settings page. Reuse
the existing PATCH settings save, authoritative response handling and dirty
draft protection. Default missing legacy configuration to disabled with an
empty server list.

Provide an outgoing primary switch and editable server name, HTTPS origin and
enabled state. Allow add/remove up to the backend limit of twenty. Explain that
peers need pre-existing accounts with matching REG_TOKEN and correct PROXY_KEY;
local account IDs may differ. Do not add credential-transfer fields.

Fetch runtime status separately from editable settings through the authenticated
registration-relay API. Show pending/failed counts, safe errors and last success.
Manual sync schedules work immediately and does not wait for delivery. Prevent
sync against an unsaved configuration and show the save prerequisite.

Only poll while the relay UI is mounted and visible. Stop timers on unmount and
ignore old session/component responses. Runtime failures stay inside the page;
they do not block console startup or navigation. Route background 401 responses
through the existing session-expired handling.

Browser coverage must prove configuration save/reload, draft preservation during
refresh, separate status display, manual sync, request cleanup and mobile layout.
Use escaped text for peer names and safe errors. Do not expose credential values
through setup hints, status JSON or runtime events.

## Cross-layer signatures and validation

The routing form saves `settings.registrationRelay` through existing
`PATCH /api/settings`: `{ enabled, servers: [{ id, name, origin, enabled }] }`.
Names contain 1–80 characters and origins use HTTPS without credentials, paths,
queries or fragments. Keep stable server IDs and limit the list to twenty.
The server returns canonical configuration; update the draft from that response.
Use the existing `crypto.getRandomValues` pattern for non-secret server IDs.
Do not require secure-context-only `crypto.randomUUID` on HTTP panel pages.

`GET /api/registration-relay` returns `{ enabled, servers }`. Runtime server
records add `status`, `pending`, `failed`, `lastAttemptAt`, `lastSuccessAt` and
`lastError`. `POST /api/registration-relay/sync` returns `{ scheduled }` and
acknowledges scheduling rather than completed delivery.

| Condition | UI behavior |
| --- | --- |
| Missing legacy setting | Disabled switch and empty list |
| Invalid name/origin or duplicate origin | Inline validation, block save |
| Unsaved settings | Preserve draft, disable manual synchronization |
| Runtime read failure | Local error with retry; retain navigation |
| Background 401 | Existing session-expired flow |
| Hidden or unmounted page | Stop polling work; ignore stale responses |

## Good, base and bad cases

- Good: save canonical HTTPS peers, inspect delivery status and manually
  synchronize current endpoints without waiting for remote completion.
- Base: an old settings document displays the disabled default.
- Bad: a delayed status read arrives after a settings save or navigation. It
  must not overwrite the newer component state or the settings draft.

## Wrong versus correct

Wrong: merge delivery status into the editable settings and replace the draft
on every background overview refresh.

Correct: store editable configuration in the existing protected routing draft
and load delivery status independently while the component is visible.
