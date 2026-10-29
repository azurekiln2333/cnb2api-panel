# Research: Registration relay console

- `web/src/views/RoutingView.vue:38-163` already supplies normalized defaults, dirty drafts, refresh protection, a PATCH `/settings` save and authoritative response handling. Add a registration-relay section to this page and reuse its save flow.
- `web/src/types.ts:85` defines Settings. Separate relay configuration from delivery runtime DTOs.
- `src/app.mjs:613-615` and `src/app.mjs:722-725` expose complete settings. Keep all registration credentials in the existing encrypted account secrets; peer settings contain names, origins and switches only.
- `web/src/views/ActivityView.vue:58` displays register events in the system log. Static delivery outcomes can reuse this channel without logging tokens or raw peer bodies.
- `src/audit.mjs:6` already audits PATCH `/api/settings`. Add explicit audit coverage for manual synchronization.
- `web/src/components/AccountDialog.vue:143-181,271-322` supports entering existing REG_TOKEN and preserving unchanged credentials. Peer pre-configuration needs documentation and a short setup hint, not a credential-copy feature.
- `web/e2e/console.spec.ts:1037` covers routing persistence. `web/e2e/request-overrides.spec.ts:12` demonstrates stale-refresh and draft-preservation tests. Add focused registration-relay interaction, status, retry and mobile assertions.

The explorer performed read-only research. No product files changed.
