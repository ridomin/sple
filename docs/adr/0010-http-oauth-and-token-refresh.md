# ADR 0010: HTTP client, OAuth flow and token refresh

- **Status:** Accepted (2026-10-07)
- **Date:** 2026-10-07
- **Deciders:** project owner (user); architect (author)
- **Related:** `docs/requirements.md` FR-AUTH-1…6, PRV-4, NFR-2, NFR-3, NFR-4, CLI-7; ADR 0003 §2 (HTTP client architecture); ADR 0004 (token store); ADR 0007 §6 (logging)
- **Supersedes:** ADR 0004 §4 (refresh sketch)

## Context

ADR 0003 §2 says each adapter owns an HTTP client that retries, refreshes tokens and respects rate limits, and FR-AUTH-1 describes the login modes. Neither gives the numbers, ordering or edge cases that M0–M3 implemented. A port in another language needs them to behave the same way: same retry budget, same refresh timing, same loopback-server rules, same error mapping. This ADR records them as the contract. Differences in the TypeScript code are tracked in `docs/requirements.md` §12.

## Decision

### 1. HTTP client

One client per provider instance, internal to the adapter (ADR 0003 §2).

**Constants**

| Name | Value |
|---|---|
| `maxRetries` | 3 (so at most 4 attempts per request) |
| `baseDelay` | 100 ms |
| `maxDelay` | 10 000 ms |
| `maxWait` | 120 000 ms (longest `Retry-After` the client will sleep) |
| Proactive refresh window | 60 s before `expiresAt` |

`backoff(attempt) = min(baseDelay × 2^attempt × U(0.8, 1.2), maxDelay)`, where `U` is a uniform random factor (±20 % jitter) and `attempt` starts at 0.

**Request flow**

1. Load the stored token. If it has a parseable `expiresAt` less than 60 s away and the adapter can refresh, refresh first (§3).
2. Add `Authorization: Bearer <accessToken>` unless the request already has an `Authorization` header.
3. Send. Every attempt, including retries and network failures, is logged on the `sple:http` namespace (§5).
4. Handle the response:

| Response | Behavior |
|---|---|
| 2xx | Return. |
| 401 | Once per request: reload the stored token. If its access token differs from the one sent (another request or process already refreshed), retry with it; otherwise refresh (§3) and retry. The retry does not count against `maxRetries`. A second 401, or no refresh possible → the adapter's mapped error, else `AuthRequiredError('no-token')`. |
| 429 | `wait = Retry-After` (delta-seconds or HTTP-date; missing or unparseable → `backoff(0)`). If `wait > maxWait` → `RateLimitError` immediately, without sleeping. Else, if `attempt < maxRetries`, sleep `wait` and retry; otherwise `RateLimitError(retryAfterMs = wait)`. |
| 5xx | If `attempt < maxRetries`: sleep `min(Retry-After, maxWait)` when the header is present, else `backoff(attempt)`; retry. After the last attempt → the adapter's mapped error, else `ProviderError("Service unavailable (HTTP <status>) after <n> retries")`. |
| Network error (no response) | Same retry and backoff as 5xx. After the last attempt the error propagates (exit 1). |
| Other non-2xx | The adapter's mapped error; if it has none: 404 → `NotFoundError('other')`, 403 → `AccessRestrictedError('other')`, else `ProviderError("HTTP request failed (HTTP <status>)")`. |

5. JSON bodies are parsed and validated at the boundary (NFR-3). A body that is not JSON → `ProviderError("Invalid JSON in response to <METHOD> <path>")`; a body that fails validation → `ProviderError` naming the field. Raw bodies never appear in messages.

`QuotaExhaustedError` is raised by adapters with `daily-buckets` quota (YouTube `403 quotaExceeded`), never retried.

### 2. OAuth authorization-code flow with PKCE (FR-AUTH-1)

**Secrets per login**

- `code_verifier` = base64url (no padding) of 32 random bytes (43 characters).
- `code_challenge` = base64url (no padding) of SHA-256(`code_verifier`); method `S256`.
- `state` = lower-case hex of 32 random bytes (64 characters).

**Authorization URL:** the provider's authorize endpoint with, in this order, the provider's extra parameters, then `client_id`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`, `state`, `scope` (space-joined) and `redirect_uri`. Standard parameters override extras with the same name.

**Modes**

| Mode | Listener | `redirect_uri` | URL handling |
|---|---|---|---|
| `loopback` (default) | yes | `http://127.0.0.1:<port>/callback` | Print the URL to stderr, then try to open the browser (WSL-aware). A browser failure is a warning, never an error. |
| `no-browser` | yes | `http://127.0.0.1:<port>/callback` | Print the URL only. |
| `manual` | no | `http://127.0.0.1/callback` (no port) | Print the URL and instructions; read one pasted line from stdin. |

The user registers exactly `http://127.0.0.1/callback` with the provider; Spotify and Google accept any port on a portless loopback registration. `localhost` is never used.

**Loopback listener**

- Binds `127.0.0.1` on port 0 (the OS picks the port). Stopped as soon as the flow ends, succeeds or fails.
- Accepts only `GET /callback` whose `Host` header is exactly `127.0.0.1:<port>` (DNS-rebinding guard). Anything else → `400` and keep waiting (e.g. `/favicon.ico`).
- Missing `state` → `400`, keep waiting.
- `state` different from the expected one → `400`, login fails (`State validation failed`).
- `error` parameter → `400`, login fails (`OAuth error: <error>`). `state` is checked before `error`.
- Missing `code` → `400`, login fails.
- Success → `200` with a small HTML page ("Authorization successful. You can close this window.").
- No redirect within 10 minutes → login fails (`OAuth redirect timeout (10 minutes)`).

**Manual paste-back:** the pasted line is trimmed and parsed as a URL. Checks in order: valid URL, `state` matches, no `error`, `code` present. End of stdin before a line → login fails (`No redirect URL received (stdin closed)`).

**Token exchange:** `POST` form-encoded to the token endpoint with `grant_type=authorization_code`, `code`, `redirect_uri` (byte-identical to the one in the authorization URL), `client_id`, `code_verifier`, and `client_secret` for Google only.

**Identity and persistence:** after the exchange, fetch the user's identity (Spotify `GET /v1/me` → `id`, `display_name`; Google `GET https://www.googleapis.com/oauth2/v2/userinfo` → `id`, `name`). Only then save the token (ADR 0004): `scopes` are the granted scopes from the token response's `scope` field (split on whitespace), falling back to the requested scopes when the field is absent; `expiresAt = now + expires_in`; `grantedAt = now`. If the identity call fails (for example the Spotify Premium 403), nothing is saved.

**CLI output:** stderr gets `Open this URL in your browser to authorize sple:`, the URL, then `Waiting for authorization...` (loopback, no-browser) or the paste instructions (manual). On success stdout gets `Logged in to <Provider>`, then `User: <displayName or id>`, `Scopes: <comma-separated>` and `Token expires: <ISO>` when known. On failure stderr gets `Login failed: <message>` and the exit code follows the error type (ADR 0007 §4).

### 3. Token refresh

- `POST` form-encoded `grant_type=refresh_token`, `refresh_token`, `client_id` (+ `client_secret` for Google).
- The new token keeps every stored field, replaces `accessToken` and `expiresAt`, replaces `refreshToken` only if the response has one (rotation), and replaces `scopes` only if the response has a `scope` field.
- The refreshed token is saved to `tokens.json` before the request is retried.
- **Single flight:** concurrent requests in one process share one in-flight refresh. A request that still holds the pre-refresh access token reuses the result of the last completed refresh instead of refreshing again.
- No stored refresh token → `AuthRequiredError('token-expired')`. `invalid_grant` → `AuthRequiredError('revoked')` with a "run `sple auth login`" message (exit 3).

### 4. Provider endpoints and error mapping

| | Spotify | Google (YouTube Music) |
|---|---|---|
| Authorize | `https://accounts.spotify.com/authorize` | `https://accounts.google.com/o/oauth2/v2/auth` |
| Token | `https://accounts.spotify.com/api/token` | `https://oauth2.googleapis.com/token` |
| Extra authorize params | none | `access_type=offline`, `prompt=consent` (needed to get a refresh token on every login) |
| Client secret | never | user's Desktop-client secret (`SPLE_GOOGLE_CLIENT_SECRET`) |
| Scopes requested | ADR 0003 Amendment 2 table | M4a: `youtube.readonly`; M4b: `youtube`; plus `userinfo.profile` for identity |
| Revoke on logout | none: delete local tokens, `revoked: false`, notice pointing to `https://www.spotify.com/account/apps/` | `POST https://oauth2.googleapis.com/revoke` `token=<access token>`; local tokens are deleted even if revocation fails |

**Spotify token-endpoint errors** (only the OAuth `error` code, `[a-z_]{1,64}`, is read from the body):

| Condition | Error |
|---|---|
| `invalid_grant` on `authorization_code` | `ProviderError` ("rejected the authorization code … run `sple auth login` again") |
| `invalid_grant` on `refresh_token` | `AuthRequiredError('revoked')` |
| `invalid_client`, `unauthorized_client`, or HTTP 401 | `ProviderError` naming `SPLE_SPOTIFY_CLIENT_ID` and the app's redirect URIs |
| 429 | `RateLimitError` with `Retry-After` |
| 5xx | `ProviderError` ("token endpoint unavailable") |
| other | `ProviderError` ("token request failed (HTTP <status>[, <code>])") |

**Spotify Web API errors:** 401 → `AuthRequiredError('token-expired')`; 403 whose JSON `error.message` matches `/premium/i` → `AccessRestrictedError('premium-required')` with the Premium explanation and setup-doc link (spike S4 fallback); other 403 → `AccessRestrictedError('other')`; 404 → `NotFoundError('other')`; 429 → `RateLimitError`; other → `ProviderError("Spotify API request failed (HTTP <status>)")`.

**YouTube Data API errors** (only `error.errors[0].reason`, an identifier of at most 64 letters or underscores, is read from the body): reason `quotaExceeded` or `dailyLimitExceeded` → `QuotaExhaustedError` (bucket `units`; "resets at midnight Pacific Time"); `rateLimitExceeded` or `userRateLimitExceeded` → `RateLimitError`; 401 → `AuthRequiredError('token-expired')`; 404 or a reason ending in `NotFound` → `NotFoundError` (`track` for `videoNotFound`, `playlist` for `playlist…`, else `other`); 409 → a conflict error, which `playlistItems.insert` retries twice (after 1 s and 2 s) because YouTube returns it transiently right after a playlist is created; other 403 → `AccessRestrictedError('other')`; anything else → `ProviderError("YouTube API request failed (HTTP <status>[, <reason>])")`. In `populatePlaylist`, auth, quota and rate-limit errors stop the run; other per-track errors are recorded and the next track runs.

### 5. Debug and redaction

Each attempt produces one `HttpLogEntry`: method, path with query string (values of `q` and `uris` cut to 20 characters plus `...`; host omitted), status or `ERR <code>` for a network error, duration in ms, and the number of earlier attempts. It is written to the `sple:http` `debug` namespace, formatted per ADR 0007 §6 and redacted by the output function from ADR 0007 A11; retries and mapped errors go to `sple:http:retry` and `sple:http:error`. Headers and bodies are never logged; token-endpoint calls log method, path, status and duration only.

## Alternatives considered

- **Leave retry numbers to each implementation.** Rejected: users of different builds would see different behavior under rate limiting, and test fixtures could not be shared.
- **Sleep for any `Retry-After`.** Rejected: Spotify can return multi-hour values; failing fast with exit 5 and the wait time is more useful than a CLI that hangs.
- **Refresh only on 401.** Rejected: proactive refresh avoids a failed request (and a wasted quota unit on YouTube) for tokens that are about to expire.
- **Device flow for headless login.** Out of scope (requirements §9); `manual` covers it.

## Consequences

- Ports get a deterministic retry budget: at most 4 attempts, at most 120 s of sleeping on one `Retry-After`.
- Tests can assert exact retry counts and refresh behavior against recorded fixtures.
- Changing a constant or a mapping needs an amendment to this ADR.
