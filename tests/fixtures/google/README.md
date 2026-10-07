# Google fixtures

- **Source:** recorded against the live Google OAuth endpoints with the sple YouTube Music client (OAuth app in Testing status).
- **Date:** 2026-10-07
- **Purpose:** token-endpoint and identity responses for the auth contract suite (`tests/providers/auth-contract.ts`, #76).

| File | Endpoint | Notes |
|---|---|---|
| `oauth-token-refresh.json` | `POST https://oauth2.googleapis.com/token` (`grant_type=refresh_token`) | Granted scopes come back in Google's order, not the requested order. `refresh_token_expires_in` (~7 days) appears because the OAuth app is in Testing status. |
| `oauth-userinfo.json` | `GET https://www.googleapis.com/oauth2/v2/userinfo` | Fields returned for the `userinfo.profile` scope. |

## Sanitization

Tokens are replaced with `REDACTED_ACCESS_TOKEN`, and `id_token` (a signed JWT carrying the user's identity) is removed. The user ID is replaced with `000000000000000000000`, the name with `Test User`, and the picture URL with `example.com`. The refresh response contains no `refresh_token`, because Google doesn't rotate refresh tokens.
