# OIDC authentication

## Scope / Trigger

Use this contract when changing management login, SSO settings, or session identity.
Gateway authentication and CNB registration tokens remain separate.

## Signatures

- Public `GET /api/auth/config` returns Key-login availability and SSO button metadata.
- Public `GET /api/auth/oidc/login` and `/api/auth/oidc/callback` implement code flow.
- Authenticated `GET/PATCH /api/auth/settings` reads or updates configuration.
- `GET /api/session` returns `authenticated` and `user` (`name`, `email`, `picture`, `provider`).
- `POST /api/session` logs in with the management Key. `DELETE` logs out either identity.

## Contracts

Settings use `ssoEnabled`, `keyLoginEnabled`, `issuer`, `clientId`, `scope`,
`providerName`, `allowedSubjects`, `allowedEmails`, and `callbackUrl`.
Only PATCH accepts `clientSecret`; blank preserves the stored value.
GET returns `hasClientSecret`, never the secret.
The secret uses existing AES-256-GCM storage in `panel.json` and `master.key`.
`PANEL_SSO_ENABLED`, `PANEL_KEY_LOGIN_ENABLED`, and `PANEL_OIDC_*` bootstrap
unconfigured installations. Saved settings take precedence.
The default `.env.example` omits these optional bootstrap variables.
Configure SSO in the console and retain `data/panel.json` and `data/master.key`.
Removing bootstrap variables does not disable saved SSO settings.

## Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Key login disabled | POST session returns 403 |
| No enabled SSO or no admin allowlist | Reject disabling Key login |
| Key session attempts to disable Key login | Reject and request a successful SSO login first |
| Invalid state, signature, issuer, audience/azp, nonce, or time claims | No session, safe auth_error redirect |
| Unlisted subject or unverified email | No administrative session |
| HTTPS provider advertises HTTP endpoints | Reject discovery |

## Good / Base / Bad Cases

Good: use discovery, S256 PKCE, state, nonce, RS256/JWKS, Basic token exchange,
and exact administrator subjects. Email access requires verified email claims.
Base: Key login stays enabled until an OIDC session verifies the configuration.
Bad: treating every identity from a trusted provider as a panel administrator.

## Tests Required

`test/panel-auth.test.mjs` verifies real signed tokens, invalid claims,
allowlists, encrypted persistence, bootstrap precedence, and disabled Key login.
`web/e2e/auth.spec.ts` verifies real browser redirects, SSO-only login, and avatar identity.
Fixtures use local mock providers only and never load production data.

## Wrong vs Correct

Wrong: truncate `sub` before allowlist comparison, or inherit verification from
a different email claim. Correct: preserve exact identifiers for authorization
and bind email verification to the actual email.
Wrong: show provider errors or token bodies in the browser. Correct: translate
bounded safe reason codes and remove callback query parameters.
