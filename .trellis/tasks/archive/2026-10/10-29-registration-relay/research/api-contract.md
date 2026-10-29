# Shared implementation contract

## Coordinator

`src/registration-relay.mjs` exports `RegistrationRelay` and `parseRelayHeaders(headers)`.

- `new RegistrationRelay(store, options)` supports injected `now`, `fetchImpl`, `timeoutMs`, `pollMs` and `publicUrl` for bounded temporary-server tests.
- `register(accountId, normalizedEndpoint, relayMetadata = null)` durably applies local registration plus receipt/outbox changes and returns `{ applied, result }`. `result` is the existing `{ok:true,accountId}` for an original CNB call, with bounded protocol acknowledgement for a relayed call. Pool keeps register logging/probing when `applied` is true.
- `reconcile()` schedules changed/new peer/current account snapshots, prunes obsolete work and kicks background dispatch without awaiting network. Call after successful settings/account changes; background scans also reconcile persisted work.
- `sync()` schedules current endpoints for enabled peers and returns `{ scheduled: number }` immediately.
- `status()` returns the DTO below.
- `start()`, `stop()` and `kick()` control background timers/fetches. `kick()` may run without Pool.start() so registrations in embedded HTTP fixtures still deliver. All network failures are contained and safely persisted.
- `parseRelayHeaders()` returns null for ordinary calls or `{ sourceId, revision }` for a complete valid versioned envelope. Errors are bounded static messages with status 400, wrapped as InputError by the app if necessary.

Core implements configuration defaults/validation and persisted runtime loading/writing in Store. App passes configured publicUrl into Store/relay options for self-origin checks. Core and integrator may refine signatures together before changing call sites; notify root/UI if a public DTO changes.

## Management API and DTO

- `settings.registrationRelay`: `{ enabled: boolean, servers: Array<{id:string,name:string,origin:string,enabled:boolean}> }`.
- GET `/api/registration-relay`: `{ enabled:boolean, servers: Array<{id:string,name:string,origin:string,enabled:boolean,status:'disabled'|'idle'|'pending'|'success'|'failed',pending:number,failed:number,lastAttemptAt:string|null,lastSuccessAt:string|null,lastError:string}> }`.
- POST `/api/registration-relay/sync`: `{scheduled:number}`; schedules background work and returns immediately.
- Both endpoints require the existing management session. Settings saving keeps GET/PATCH `/api/settings` unchanged aside from the additive field.
- Runtime DTOs never enter the editable settings payload. No new configuration secrets.

## Ownership

- Core: `src/registration-relay.mjs`, `src/store.mjs`, `test/registration-relay.test.mjs` and core-only persistence tests if needed.
- Integration: `src/app.mjs`, `src/pool.mjs`, `src/audit.mjs`, `test/panel-registration-relay.test.mjs`.
- UI: `web/src/views/RoutingView.vue`, optional `web/src/components/RegistrationRelaySettings.vue`, `web/src/types.ts`, narrowly needed `web/src/console.ts`, `web/e2e/registration-relay.spec.ts`, narrowly needed CSS.
- Root: README/specs/task artifacts/version metadata and release coordination.
