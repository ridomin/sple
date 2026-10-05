# M1 Implementation Plan

**Milestone:** M1 — Spotify MVP  
**Scope:** Spikes S1–S4, then FR-AUTH (M), FR-SEARCH (M), FR-PL (M), FR-EXP (M, including Liked Songs), CLI-1…8  
**Builds on:** M0 (provider interface + capabilities, fake provider, HTTP client, OAuth handler, token store, CLI entry point, provider registry)  
**Gate:** No Phase 3+ code is merged until Phase 1 (spikes) and Phase 2 (design updates) are merged. Spike results that contradict the requirements change `docs/requirements.md` and ADR-0003 first (requirements §10 resolution rule).  
**Out of scope for M1:** FR-PL-5 (edit), FR-SEARCH-3 (field filters), FR-EXP-5 (`export --all`), `playlist list --filter`. These are M2 items in requirements §11. Also out of scope: `resolveTrack` / `populatePlaylist` (M3/M4b) and the YouTube adapter beyond the M0 stub (M4a).

## Sources (checked 2026-10-02)

- February 2026 migration guide: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- February 2026 changelog: https://developer.spotify.com/documentation/web-api/references/changes/february-2026
- Get Playlist Items (`GET /playlists/{id}/items`, limit 1–50, field `item`, deprecated `track`): https://developer.spotify.com/documentation/web-api/reference/get-playlists-items
- Get Saved Tracks (`GET /me/tracks`, limit 1–50, `user-library-read`): https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks
- Get Current User's Playlists (`GET /me/playlists`, limit 1–50, offset ≤ 100,000, `items.total`): https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists
- Create Playlist (`POST /me/playlists`, collaborative requires `public: false`): https://developer.spotify.com/documentation/web-api/reference/create-playlist
- Remove Library Items (`DELETE /me/library?uris=…`, max 40 URIs, scopes `user-library-modify` | `user-follow-modify` | `playlist-modify-public`): https://developer.spotify.com/documentation/web-api/reference/remove-library-items
- PKCE flow / token refresh: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow, https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens
- Redirect URIs (loopback rules): https://developer.spotify.com/documentation/web-api/concepts/redirect_uri

## M0 carry-over gaps (verified in code, 2026-10-02)

M1 assumes M0 is complete. A code review found the gaps below. They are scheduled as M1 tasks, not reopened M0 tasks.

| Gap | Location | Fixed in |
|---|---|---|
| Loopback server binds `localhost` and uses redirect `http://localhost:<port>/`. Spotify rejects `localhost`, and FR-AUTH-1 requires `http://127.0.0.1:<port>/callback`. | `src/core/auth/oauth-handler.ts` | M1-9 |
| No browser opener. The authorization URL is never printed. | `src/cli/commands/auth/login.ts` | M1-9 |
| Spotify `login()` is a stub. There's no token exchange and no `GET /me`. | `src/providers/spotify/auth.ts` | M1-10 |
| `onRefreshToken` gets `{}` instead of the stored token. The client never adds the `Authorization` header itself. | `src/core/http/client.ts` | M1-12 |
| Non-2xx responses (400/403/404) throw a plain `Error`, not the closed error types. Exit codes are therefore wrong. | `src/core/http/client.ts` | M1-12 |
| Spotify scopes lack `user-library-read` (needed for FR-EXP-6). | `src/providers/spotify/auth.ts` | M1-11 |
| Tooling differs from the M0 plan: the repo uses `node:test` + `tsx` and `tsc --noEmit` as lint; ADR-0006 (stack) is missing. | `package.json`, `docs/adr/` | M1-27 (coverage), M1-29 (ADR-0006) |

## Task Breakdown

### Phase 1: Spikes (S1–S4)

Spikes run against the live Spotify API with the project owner's own Development Mode app and Premium account. Spike code is never part of the shipped build or CI.

**[M1-1] Spike harness**
- Create `scripts/spikes/spotify/` (excluded from `tsconfig` build output and from `npm test`)
- `login.ts`: standalone PKCE login using `generatePKCEPair()` from M0 and its own `127.0.0.1` listener on `/callback`. It writes the token to a scratch file given on the command line (never `tokens.json`).
- `call.ts`: makes a raw authenticated request and dumps status, headers (minus `authorization`), and body to `scripts/spikes/spotify/out/<spike>-<n>.json` (git-ignored)
- `sanitize.ts`: strips user IDs, display names, emails, image URLs, and tokens from dumps so they can become test fixtures
- README in the folder: how to run, what not to commit

**Acceptance criteria:**
- `npx tsx scripts/spikes/spotify/login.ts --out <file>` gets a real access token for a Development Mode app
- `out/` and token files are git-ignored. A dry `git status` after a run shows no new tracked files.
- Sanitizer output contains no 22-char user IDs, no `Bearer`, no `access_token`/`refresh_token` values
- `npm run build` output does not contain `scripts/`

---

**[M1-2] Spike S1: ISRC search filter**
- `GET /search?q=isrc:<ISRC>&type=track&limit=10` for 5 well-known ISRCs (record which ones)
- Also record whether any track object in search results contains `external_ids`

**Acceptance criteria:**
- Result recorded as `isrcSearchMode: 'filter'` (search returns the expected track for ≥ 4 of 5) or `'none'`
- Raw sanitized responses saved as fixtures `tests/fixtures/spotify/search-isrc-*.json`
- Confirmed that `external_ids` is absent (or noted if present)

---

**[M1-3] Spike S2: collaborator playlist access**
- Needs a second Spotify account (Free is fine) that owns a collaborative playlist with the spike user added as a collaborator
- Record for four cases (owned, collaborator, followed non-collaborative, editorial):
  - `GET /playlists/{id}`: is the `items` object present?
  - `GET /playlists/{id}/items`: HTTP status, and body shape (200 with items / 200 without / 403 / 404)
- Record whether `GET /me/playlists` marks collaborator playlists in any way, beyond `collaborative: true` and `owner.id` differing from the user

**Acceptance criteria:**
- A table of the 4 cases × 2 endpoints with status and body shape
- A decision on `playlistItemsAccess`: stays `'owned-only'`, or becomes `'owned-or-collaborator'` (needs the ADR-0003 type amendment in M1-7)
- The exact "not readable" signal (status code and/or missing field) recorded, so the adapter can detect it reliably

---

**[M1-4] Spike S3: page-size limits**
- For `GET /playlists/{id}/items`, `GET /me/tracks`, and `GET /me/playlists`: call with `limit=50` and `limit=51`
- For `GET /search`: `limit=10` and `limit=11`. Also find the maximum `offset` (try `offset=990` and `offset=1000` with `limit=10`).
- Time a 1,000-track owned playlist read: sequential, and with 4 parallel pages

**Acceptance criteria:**
- Max `limit` for each endpoint, and the error status/body when it's exceeded, recorded
- Max search offset recorded (sets the `--all` hard cap in M1-19)
- NFR-5 feasibility confirmed: ≤ 15 s for 1,000 tracks with bounded concurrency. Otherwise the requirements are updated.

---

**[M1-5] Spike S4: missing Premium, plus write and allowlist checks**
- Needs a Spotify account without Premium that owns its own Development Mode app (see open question 1)
- Record the exact behavior at each step: `/authorize` redirect (error param?), `/api/token` response, and the first `GET /me` (status, body `error.message`)
- With the Premium owner account, also record:
  - (a) whether the app owner must be listed under the app's *User Management* to log in
  - (b) whether `DELETE /me/library?uris=spotify:playlist:<id>` works for a *private* owned playlist when only `playlist-modify-public` + `playlist-modify-private` are granted (no `user-library-modify`)
  - (c) the `POST /me/playlists` response with `collaborative: true, public: true`

**Acceptance criteria:**
- The exact detection rule for "Premium required" (status + body match) written down, with a sanitized fixture
- Findings (a)–(c) recorded. If (b) fails, the required scope is added to the M1-11 scope table.
- If no non-Premium account is available, S4 is marked *unverified*. The fallback rule (M1-11) is documented as a heuristic.

---

**[M1-6] Record spike results**
- Create `docs/spikes/M1-spotify-spikes.md`: date, app mode, account types, results table per spike, links to fixtures
- Update `docs/requirements.md` §8 (Spotify constraints) and §10 (mark S1–S4 resolved with results)
- Update the ADR-0003 §5 capability values (`isrcSearchMode`, `playlistItemsAccess`) and add an amendment note
- Move the sanitized responses into `tests/fixtures/spotify/` with a `README.md` stating their source and date

**Acceptance criteria:**
- Every spike has a result and a decision, or is explicitly marked *unverified* with a fallback
- Requirements and ADR-0003 agree with the spike results (no contradictions left)
- Fixtures are committed sanitized (reviewed manually against the M1-1 sanitizer rules)

---

### Phase 2: Design Updates

**[M1-7] Amend ADR-0003: interface additions for M1**
- Add `parsePlaylistRef` to `Provider`. Ref parsing is provider-specific, and the core must not branch on provider ID (PRV-5).
- Replace `search(): Promise<Page<unknown>>` with a typed result (FR-SEARCH-4)
- If S2 confirms collaborator access: add `'owned-or-collaborator'` to `playlistItemsAccess`. Readability of a non-owned collaborative playlist is then decided at read time, from the signal recorded in M1-3.
- Add optional `displayName?: string` to `StoredToken`. This is an additive field, so it stays schemaVersion 1 (ADR-0004), and `auth status` works offline.
- Update the fake provider and its tests for the new members
- Spotify adapter: set the capability values from M1-6

```ts
// src/core/provider/provider.ts (additions)
export type SearchType = 'track' | 'album' | 'artist' | 'playlist'

interface SearchItemBase { id: string; ref: string; url?: string; name: string }
export type SearchItem =
  | (SearchItemBase & { type: 'track'; track: CanonicalTrack })
  | (SearchItemBase & { type: 'album'; artists: string[]; releaseDate?: string; trackCount?: number })
  | (SearchItemBase & { type: 'artist' })
  | (SearchItemBase & { type: 'playlist'; owner: { id: string; displayName?: string }; trackCount?: number })

export interface Provider {
  // …existing members…
  search(q: { text: string; type: SearchType }, page: PageRequest): Promise<Page<SearchItem>>
  /** Returns a provider ref if `input` is an ID, URI, or URL for this provider; otherwise null (caller falls back to name lookup). Pure, no I/O. */
  parsePlaylistRef(input: string): string | null
}
```

**Acceptance criteria:**
- ADR-0003 has a dated "Amendment 1 (M1)" section listing each change and why
- `npm run lint` and `npm test` pass. The fake provider implements the new members.
- No core or CLI module imports from `src/providers/spotify/`

---

**[M1-8] ADR-0007: CLI conventions and output contracts**
- Command grammar `sple <noun> <verb>` (`search` and `export` are single-verb nouns). Argument parsing stays on `node:util` `parseArgs` with `strict: true` per command, with no CLI framework dependency.
- Output modes (CLI-2):
  - Default when stdout is a TTY: a table
  - Default when stdout is not a TTY: tab-separated text without headers. Note this is a decision, not a requirements quote.
  - `--json`: one stable shape per command, written to stdout
  - `--quiet`: IDs only, one per line
  - `--json` and `--quiet` are mutually exclusive (UsageError)
- `--json` shapes for `search`, `playlist list|show|create|remove`, `export` (when writing to files), and `auth status`
- Errors and warnings always go to stderr. With `--json`, a failure also writes `{ "error": { "type", "message", "exitCode" } }` to stderr.
- Stdin (CLI-3):
  - `-` reads newline-separated playlist refs
  - `show`/`remove` need exactly one
  - `remove -` needs `--yes`, because stdin isn't available for the prompt
- Partial-failure rule (NFR-4): multi-item commands keep going, print a summary to stderr, and exit with the highest-priority code seen. Priority order is 3 > 5 > 4 > 1.
- Logging (CLI-7):
  - `--verbose` enables `sple:*` info logs
  - `--debug` adds HTTP request lines, but never headers, request bodies, or token-endpoint responses
- Progress (CLI-8): only when `process.stderr.isTTY` and not `--quiet`/`--json`

**Acceptance criteria:**
- ADR-0007 is accepted and cross-linked from requirements §6
- Every M1 command has its `--json` shape written out as a TypeScript type in the ADR

---

### Phase 3: Spotify Authentication (FR-AUTH)

**[M1-9] Fix loopback redirect and add browser opener (FR-AUTH-1)**
- `LoopbackServer`:
  - Bind `127.0.0.1` only
  - Use redirect URI `http://127.0.0.1:<port>/callback`
  - Accept only the `/callback` path
  - Accept only `Host: 127.0.0.1:<port>`
- Manual mode uses redirect URI `http://127.0.0.1/callback` (no port) and no listener. The user pastes the failed-to-load URL.
- `--no-browser`: the listener still runs, but the browser is not opened
- Create `src/core/auth/browser.ts` with `openBrowser(url)`:
  - Use the `open` package (WSL-aware) behind a small wrapper so tests can stub it
  - Failure to open is a warning, not an error
- `login.ts`: always print the authorization URL to stderr before waiting. Wire `--manual` to read a line from stdin (`node:readline/promises`).

**Acceptance criteria:**
- Unit tests: the server rejects `localhost` Host, wrong path, and wrong state. The redirect URI has the form `http://127.0.0.1:<port>/callback`.
- Manual mode builds the authorize URL with `redirect_uri=http://127.0.0.1/callback`
- The URL is printed in all three modes. The browser is opened only in `loopback` mode.
- Manual check on Linux, WSL, macOS, and Windows recorded in `docs/testing/M1-auth-manual-testing.md`

---

**[M1-10] Spotify token exchange, identity, and refresh (FR-AUTH-1, FR-AUTH-3)**
- `SpotifyAuth.login()`:
  1. `OAuthHandler.initiateLogin(mode)`
  2. Print/open the URL
  3. `completeLogin()`
  4. `POST https://accounts.spotify.com/api/token` (form-encoded: `grant_type=authorization_code`, `code`, `redirect_uri` (byte-identical to the one sent to `/authorize`), `client_id`, `code_verifier`)
  5. `GET /me` for `id` + `display_name`
  6. `saveTokens()` with the *granted* `scope` from the token response, not the requested one
- `SpotifyAuth.refresh(token)`: `grant_type=refresh_token`, `refresh_token`, `client_id`. Persist the new `refresh_token` if one is returned (rotation); otherwise keep the old one.
- `invalid_grant` on refresh → `AuthRequiredError('…run "sple auth login"', 'revoked')`
- Token-endpoint request and response bodies are never logged

**Acceptance criteria:**
- Tests with mocked `fetch` cover: success, `error=access_denied` in the redirect, a token endpoint 400, refresh with and without rotation, and `invalid_grant` → exit 3
- `tokens.json` contains real values after login, with `0600` permissions (POSIX)
- No `stub-` literals remain in `src/providers/spotify/`

---

**[M1-11] Scopes, Premium detection, status and logout (FR-AUTH-2, -4, -5, -6)**
- Scope table in `src/providers/spotify/scopes.ts`, mapping `ProviderOperation` to required scopes:
  - `listPlaylists`: `playlist-read-private`, `playlist-read-collaborative`
  - `getPlaylistItems`: `playlist-read-private`
  - `readLiked`: `user-library-read`
  - `createPlaylist`: `playlist-modify-public` or `playlist-modify-private`, depending on visibility; both for collaborative
  - `removePlaylist`: per S4(b)
  - `search`: none
- Login requests the union of the M1 table and nothing more. The adapter checks granted scopes before each call and throws `AuthRequiredError(…, 'missing-scope', scope)` with the message `Run "sple auth login" to grant <scope>`.
- Premium:
  - Apply the S4 detection rule in the Spotify error mapper → `AccessRestrictedError(…, 'premium-required')`
  - The message explains the Premium prerequisite and links to the setup docs
  - At login, if `GET /me` hits this, tokens are **not** saved and the command exits 1
- `auth status`:
  - Shows displayName + ID, granted scopes, and expiry
  - Without `--provider`, lists every registered provider
  - Supports `--json`
- `auth logout`:
  - Deletes the tokens
  - Prints that Spotify has no revoke endpoint, with the account Apps page URL (`https://www.spotify.com/account/apps/`)
  - `--all` logs out every provider; client config is untouched

**Acceptance criteria:**
- Each M1 command, run with a token missing its scope, exits 3 and names the scope
- The Premium fixture from S4 maps to exit 1 and the documented message
- Logged in to both `spotify` and `fake` at once: status lists both, `logout --provider fake` leaves Spotify intact (FR-AUTH-6)

---

### Phase 4: HTTP Client and Pagination

**[M1-12] Harden the HTTP client**
- Constructor takes `getToken(): Promise<StoredToken | null>` and `refresh(token: StoredToken): Promise<StoredToken>`. The client adds `Authorization: Bearer …` itself.
- Refresh behavior:
  - Proactive refresh when `expiresAt` is < 60 s away
  - Reactive refresh on 401 (once per request)
  - **Single-flight:** concurrent requests share one in-flight refresh
- `mapError(res): ProviderError | undefined` hook supplied by the adapter. Default: 404 → `NotFoundError`, 403 → `AccessRestrictedError('other')`, 400 → `ProviderError`.
- 429 behavior:
  - Honor `Retry-After` up to `maxWaitMs` (default 120 s)
  - Above that, or after `maxRetries`, throw `RateLimitError(retryAfterMs)` → exit 5
- Add `requestJson<T>(req, validate: (x: unknown) => T)` for boundary validation (NFR-3)
- Debug log: method, path (query values for `uris`/`q` truncated), status, and duration only. Bodies are never logged.

```ts
// src/core/http/client.ts
export interface HttpClientOptions {
  providerId: ProviderId
  baseUrl: string
  getToken: () => Promise<StoredToken | null>
  refresh: (current: StoredToken) => Promise<StoredToken>
  mapError?: (res: HttpResponse) => ProviderError | undefined
  maxRetries?: number   // default 3
  maxWaitMs?: number    // default 120_000
}
```

**Acceptance criteria:**
- Tests:
  - 10 concurrent 401s trigger exactly 1 refresh
  - Proactive refresh fires
  - `Retry-After: 3600` → immediate `RateLimitError`
  - 403/404 map to closed types
  - No token string appears in captured debug output
- No `as any` in `client.ts`

---

**[M1-13] Pagination helpers**
- Create `src/core/pagination.ts`:
  - `paginate<T>(fetchPage, { pageSize, startOffset?, maxResults?, model })`: an async iterator
  - `collectAll<T>(fetchPage, { pageSize, concurrency, maxResults? })`: for offset pagination with a known `total`. It fetches the first page, then the rest with bounded concurrency (default 4), and keeps order.
- `limit` larger than `maxSearchPageSize` is split into several requests (FR-SEARCH-2)
- `cursor-forward` providers ignore `concurrency` and reject `startOffset` with `UsageError`

**Acceptance criteria:**
- Tests against the fake provider cover:
  - Order is preserved under concurrency
  - The `maxResults` cap is exact
  - Offset on a cursor provider → exit 2
  - Total changes mid-read (stop at the first short page)
- No provider-specific code in `pagination.ts`

---

### Phase 5: CLI Framework (CLI-1…8)

**[M1-14] Command router and help (CLI-1, CLI-4, CLI-5, CLI-6)**
- Refactor `src/cli/cli.ts` into:
  - A router: global flags (`--provider`, `--json`, `--quiet`, `--verbose`, `--debug`, `--help`, `--version`), then dispatch to `src/cli/commands/<noun>/<verb>.ts`
  - Each command exports `{ name, summary, usage, options, run(ctx) }`
- `--help` works on every noun and verb (`sple playlist --help`, `sple playlist show --help`)
- `import`/`migrate` stay listed but exit 2 with "available in a later release"
- Precedence flag > env > `.env` file is kept (ADR-0004)

**Acceptance criteria:**
- Snapshot tests for every help text
- Unknown verb → exit 2 with a suggestion
- `sple --provider fake playlist list` works end to end (PRV-5 proof)

---

**[M1-15] Output layer and logging (CLI-2, CLI-7)**
- Create `src/cli/output.ts`:
  - `emit(ctx, { table: Row[] & columns, json: unknown, quiet: string[] })`. It picks the mode from flags and `process.stdout.isTTY`.
  - A small in-house table renderer (column widths, truncation to terminal width, no ANSI when not a TTY)
- Create `src/cli/log.ts`: maps `--verbose`/`--debug` to the `debug` namespaces, and redacts anything matching `Bearer \S+`, `access_token`, `refresh_token`, or `code=`

**Acceptance criteria:**
- Each mode is tested for one command
- `--json` output parses as JSON and matches the ADR-0007 type (via a compile-time `satisfies` check in tests)
- A redaction test passes with a crafted log line

---

**[M1-16] Stdin input, progress, confirmation (CLI-3, CLI-8, FR-PL-6)**
- `readRefsFromStdin()`: reads newline-separated refs, ignores blank lines and `#` comments
- `progress(label, total?)`: writes to stderr and only renders when stderr is a TTY. It's a no-op otherwise.
- `confirm(question)`: uses `node:readline/promises`. With no TTY on stdin and no `--yes` → `UsageError` (exit 2).

**Acceptance criteria:**
- `sple playlist list --quiet | sple export - -o dir/` works against the fake provider in a test
- Progress output never appears when stderr is piped
- `remove` without `--yes` in a non-TTY test exits 2 and makes no API call

---

**[M1-17] Playlist reference resolver (FR-PL-2, FR-PL-4)**
- Create `src/core/playlist-resolver.ts` with `resolvePlaylist(provider, input)`:
  1. `provider.parsePlaylistRef(input)` → `getPlaylist(ref)`
  2. Otherwise, exact name match (case-sensitive first, then case-insensitive) across `listPlaylists` (all pages, cached per process)
  3. 0 matches → `NotFoundError` (exit 4)
  4. More than 1 → `UsageError` (exit 2) listing name, ID, owner, and owned for each match
- Spotify `parsePlaylistRef` accepts:
  - a bare 22-char base62 ID
  - `spotify:playlist:<id>`
  - `https://open.spotify.com/[intl-xx/]playlist/<id>[?…]`
- An ID-shaped input is always treated as an ID (documented)

**Acceptance criteria:**
- Table-driven tests for every input form, an ambiguous name, a missing name, and URLs with `si=` params
- The resolver has no provider-specific code

---

### Phase 6: Spotify Adapter

**[M1-18] Spotify mappers and boundary validation (PRV-3, NFR-3)**
- Create `src/providers/spotify/mappers.ts` and `schemas.ts`: hand-written type guards (no new dependency), for the response shapes used in M1 only
- Track → `CanonicalTrack`:
  - `isrc: null` (provider confirmed absent, ADR-0005)
  - `refs.spotify = track.uri`
  - Empty artists → `['Unknown Artist']`
- Playlist items:
  - Read `item`, falling back to the deprecated `track` field
  - `is_local`, `type: 'episode'`, and `null` items are kept as `UnsupportedItem { position, kind, name?, uri? }`, not dropped silently
- Playlist → `PlaylistSummary`:
  - `owned = owner.id === me.id`
  - `trackCount = items.total`
  - `itemsReadable` follows M1-7

**Acceptance criteria:**
- Mapper tests run on the sanitized S1–S4 fixtures
- Malformed payloads throw a `ProviderError` saying which field failed (exit 1), never a `TypeError`

---

**[M1-19] Search (FR-SEARCH-1, -2, -4)**
- `GET /search?q=&type=&limit=≤10&offset=`. `--limit N` is split across pages of `maxSearchPageSize`.
- `--all`: reads until exhausted or the cap. The cap defaults to 100 results, can be overridden with `--max-results`, and has a hard ceiling equal to the S3 max offset.
- `--offset` is allowed because `paginationModel` is `offset`
- Results carry `id`, `ref` (URI), and `url` (FR-SEARCH-4)

**Acceptance criteria:**
- `--limit 25` → exactly 3 requests (10/10/5) in the fixture test
- `--all` stops at the cap
- The `--max-results` ceiling is enforced with exit 2

---

**[M1-20] Playlist reads and Liked Songs (FR-PL-1, FR-PL-2, FR-EXP-6)**
- `listPlaylists`: `GET /me/playlists?limit=50`. `getPlaylist`: `GET /playlists/{id}`. The current user ID is cached from the token store, with `GET /me` as fallback.
- `getPlaylistTracks`:
  - Fail fast with `AccessRestrictedError('not-owned')` when `itemsReadable` is false
  - Otherwise `GET /playlists/{id}/items?limit=<S3 max>`, and map the "not readable" signal from S2 to the same error
- `getLikedTracks`: `GET /me/tracks?limit=<S3 max>`. `addedAt` comes from `added_at`.
- The not-owned message:
  - Explains the restriction
  - Gives the workaround: copy the tracks into a playlist you own in the Spotify app, then use that playlist
  - Mentions collaborator access if S2 confirmed it

**Acceptance criteria:**
- Fixture tests: owned, not-owned (exit 1 before any items call), collaborator (per S2), Liked Songs with 120 items over 3 pages
- `addedAt` and the item order are preserved

---

**[M1-21] Playlist writes (FR-PL-3, FR-PL-4)**
- `createPlaylist`: `POST /me/playlists`. `collaborative: true` with `public: true` → `UsageError` before any API call (Spotify requires `public: false`).
- `removePlaylist`: `DELETE /me/library?uris=spotify:playlist:<id>` → `{ action: 'unfollowed' }`
- `resolveTrack` and `populatePlaylist` still throw. Replace the generic `Error` with `UsageError('… not available in this release')` so the exit code is predictable.

**Acceptance criteria:**
- Fixture tests: public/private/collaborative create, remove returns `unfollowed`, the scope check from M1-11 runs before the request
- A 403 on remove maps to a closed error type

---

### Phase 7: Commands

**[M1-22] `sple search` (FR-SEARCH-1, -2, -4)**
- `sple search <query> [--type track|album|artist|playlist] [--limit N] [--offset N | --all [--max-results N]]`
- Columns per type. Tracks: title, artists, album, duration, ID. `--quiet` prints IDs; `--json` prints `Page<SearchItem>`.

**Acceptance criteria:**
- Runs against both the fake and the Spotify fixtures
- `--offset` with `--all` → exit 2
- Default `--type track` and default `--limit 10` are documented in help

---

**[M1-23] `sple playlist list` and `sple playlist show` (FR-PL-1, FR-PL-2)**
- `list [--owned | --followed]`:
  - Columns: name, ID, tracks, owner, owned, public, collaborative
  - `--owned` and `--followed` are mutually exclusive (exit 2)
  - Pages are fetched with bounded concurrency and a progress indicator
- `show <playlist|->`:
  - Resolves the playlist (M1-17)
  - Columns: #, title, artists, album, duration, added at, ID
  - Unsupported items are listed in a stderr warning with a count

**Acceptance criteria:**
- A not-owned playlist exits 1 with the workaround message
- An ambiguous name exits 2 and lists the matches
- `--quiet` output pipes into `export -`

---

**[M1-24] `sple playlist create` and `sple playlist remove` (FR-PL-3, FR-PL-4, FR-PL-6)**
- `create <name> [--description] [--public | --private] [--collaborative] [--dry-run]`. Default is `--private`. `--collaborative` implies private, and `--collaborative --public` → exit 2.
- `remove <playlist|-> [--yes] [--dry-run]`:
  - The prompt and `--help` state what `remove` does, based on `canDeletePlaylist`. For Spotify: "Spotify cannot delete playlists; this unfollows it (removes it from your library). Owned playlists can be restored from your Spotify account page."
- `--dry-run` resolves inputs and prints the planned action. It makes no write calls.

**Acceptance criteria:**
- Dry-run tests show zero `POST`/`DELETE` requests
- Remove without `--yes` on a non-TTY → exit 2
- The capability-driven wording comes from capabilities, with no `provider.id` checks

---

**[M1-25] Export format: ADR-0008, JSON Schema, writers (FR-EXP-2, -3, -8)**
- ADR-0008 "Canonical playlist file": defines `CanonicalPlaylistFile` v1, and the CSV columns and dialect
- `schemas/canonical-playlist.v1.schema.json` (JSON Schema 2020-12), published in the npm package
- Create `src/core/export/json-writer.ts` and `csv-writer.ts`:
  - CSV follows RFC 4180, UTF-8 without BOM, CRLF line endings
  - CSV columns: `position,title,artists,album,duration_ms,added_at,isrc,ref`, with artists joined by `; `
  - Cell values are not changed (see open question 8)

```ts
// src/core/export/format.ts
export interface CanonicalPlaylistFile {
  schemaVersion: 1
  exportedAt: string                                   // ISO 8601 UTC
  generator: { name: 'sple'; version: string }
  source: { provider: ProviderId; kind: 'playlist' | 'liked'; userId?: string }
  playlist: {
    ref?: string; id?: string; name: string; description?: string
    owner?: { id: string; displayName?: string }
    public?: boolean; collaborative?: boolean; url?: string
    trackCount: number
  }
  tracks: Array<CanonicalTrack & { position: number }>
  unsupportedItems: Array<{ position: number; kind: 'local' | 'episode' | 'unavailable'; name?: string; ref?: string }>
}
```

**Acceptance criteria:**
- Every JSON writer output validates against the published schema in tests (schema validation in tests only; no runtime dependency)
- CSV round-trip test: quotes, commas, newlines, and non-ASCII in titles
- Liked Songs files use `source.kind: 'liked'` and `playlist.name: 'Liked Songs'`

---

**[M1-26] `sple export` (FR-EXP-1, -2, -3, -6)**
- `sple export <playlist…|-> | --liked [-o path] [--format json|csv] [--force]`
- Output destination:
  - One source and no `-o` → stdout
  - One source with `-o <file>` → that file
  - More than one source → `-o <dir>` is required (exit 2 otherwise), and files are named `<slug(name)>-<id>.<ext>` (Liked Songs: `liked-songs.<ext>`)
- File handling:
  - Existing files are not overwritten without `--force` (exit 2)
  - Writes are atomic (temp file + rename)
- Unreadable playlists are skipped with the `playlist show` message (FR-EXP-1). The rest continue, there's a summary on stderr, and the exit code follows the ADR-0007 partial-failure rule.
- `--all` is **not** in M1 (FR-EXP-5 is M2; see open question 3). Passing it gives exit 2 with "available in a later release".
- Progress indicator per playlist, with a track count

**Acceptance criteria:**
- A 1,000-track fixture export finishes in < 2 s with mocked HTTP. The live check is in M1-28.
- `--liked` without `user-library-read` → exit 3
- A mix of readable and not-owned playlists writes the readable ones and exits 1 with a summary

---

### Phase 8: Testing and Documentation

**[M1-27] Test coverage and fixtures (NFR-6)**
- Add `c8` and an `npm run coverage` script with thresholds: ≥ 80% lines on `src/core/**` and `src/providers/spotify/**`
- CI runs coverage on Node 20 and 22. Tests never call real APIs: a global `fetch` guard throws on any unmocked request.
- Fixture tests use only the sanitized spike fixtures plus synthetic data

**Acceptance criteria:**
- `npm run coverage` passes the thresholds in CI
- The `fetch` guard is active in all test files (verified by a test that expects it to throw)

---

**[M1-28] Manual end-to-end checklist and performance check**
- Create `docs/testing/M1-manual-testing.md`. It runs every M1 command against a live Premium account, in all 3 login modes, on Linux, WSL, macOS, and Windows.
- NFR-5: time `sple export <1,000-track playlist>` live and record the result

**Acceptance criteria:**
- Checklist completed and signed off with date and versions
- NFR-5 measured at < 15 s, or a requirements change is raised

---

**[M1-29] Documentation and release**
- `docs/user/spotify-setup.md`:
  - Prerequisites: Premium; 1 Client ID per developer; 5 users; User Management finding from S4(a)
  - Registering the redirect URI `http://127.0.0.1/callback`
  - Setting `SPLE_SPOTIFY_CLIENT_ID` in `.env`
- `docs/user/commands.md`: every command, flag, exit code, `--json` shape (links to ADR-0007), and what `remove` does per provider
- `docs/user/export-format.md`: links to the schema. States that export files are the user's own data (FR-EXP-8, NFR-9).
- ADR-0006 (stack: Node ≥ 20, ESM, `node:test` + `tsx`, `tsc` lint, `c8`, dependency policy). This closes the M0 gap.
- README quick start. CHANGELOG entry for M1, version bump (see open question 5).

**Acceptance criteria:**
- A new user can go from zero to `sple playlist list` using only `docs/user/spotify-setup.md` (dry-run by someone who didn't write it)
- All ADRs (0003 amendment, 0006, 0007, 0008) are accepted and cross-linked
- `npm pack` includes `dist/` and `schemas/`, and excludes `scripts/` and `tests/`

---

## Dependency Graph

```
Phase 1: [M1-1] Spike harness
            ↓
         [M1-2] S1   [M1-3] S2   [M1-4] S3   [M1-5] S4     (independent; any order)
            └───────────┴──────────┴───────────┘
                              ↓
         [M1-6] Record results (requirements §8/§10, ADR-0003 values, fixtures)
                              ↓                                   ── GATE ──
Phase 2: [M1-7] ADR-0003 amendment ──→ [M1-8] ADR-0007 CLI conventions
            ↓                              ↓
Phase 3: [M1-9] Loopback + opener ──→ [M1-10] Token exchange/refresh ──→ [M1-11] Scopes/Premium/status
            ↓                              ↓
Phase 4: [M1-12] HTTP client hardening (needs M1-10 refresh) ──→ [M1-13] Pagination helpers
            ↓
Phase 5: [M1-14] Router/help ──→ [M1-15] Output/logging ──→ [M1-16] Stdin/progress/confirm
                                           ↓
                                 [M1-17] Playlist resolver (needs M1-7, M1-13)
            ↓
Phase 6: [M1-18] Mappers ──→ [M1-19] Search
                        ├──→ [M1-20] Playlist reads + Liked (needs M1-11, M1-12, M1-13)
                        └──→ [M1-21] Playlist writes (needs M1-11)
            ↓
Phase 7: [M1-22] search cmd        ← M1-19, M1-15
         [M1-23] playlist list/show ← M1-20, M1-17, M1-16
         [M1-24] playlist create/remove ← M1-21, M1-17, M1-16
         [M1-25] Export format/ADR-0008 ← M1-18 (can start after M1-7)
         [M1-26] export cmd        ← M1-20, M1-25, M1-16
            ↓
Phase 8: [M1-27] Coverage gate ──→ [M1-28] Manual E2E + NFR-5 ──→ [M1-29] Docs + release
```

Parallel tracks after the gate: Phase 3 (auth) and Phase 5 (CLI framework, against the fake provider) can run in parallel. M1-25 can start as soon as M1-7 is merged.

## Effort Estimate

| Task | Effort | Notes |
|---|---|---|
| M1-1 | 1d | Standalone PKCE script, dump + sanitizer |
| M1-2 | 0.5d | S1 ISRC filter |
| M1-3 | 0.5d | S2 collaborators; needs a second account |
| M1-4 | 0.5d | S3 limits + timing |
| M1-5 | 1d | S4 Premium + allowlist + unfollow scope; needs a non-Premium account |
| M1-6 | 1d | Requirements/ADR updates, fixture curation |
| M1-7 | 1.5d | Interface amendment, fake provider update |
| M1-8 | 1d | ADR-0007 (doc only) |
| M1-9 | 1.5d | Loopback fix, opener, cross-platform check |
| M1-10 | 2d | Token exchange, `/me`, refresh rotation |
| M1-11 | 1d | Scope table, Premium mapping, status/logout |
| M1-12 | 2d | Token injection, single-flight refresh, error mapping |
| M1-13 | 1.5d | Iterator + bounded concurrency |
| M1-14 | 2d | Router refactor, per-command help |
| M1-15 | 2d | Table renderer, output modes, redaction |
| M1-16 | 1d | Stdin, progress, confirm |
| M1-17 | 1d | Resolver + Spotify ref parsing |
| M1-18 | 1.5d | Mappers + type guards |
| M1-19 | 1d | Search adapter |
| M1-20 | 2d | Playlists, items, Liked Songs |
| M1-21 | 1d | Create/unfollow |
| M1-22 | 1d | search command |
| M1-23 | 1.5d | list/show commands |
| M1-24 | 1.5d | create/remove commands, dry-run, confirm |
| M1-25 | 1.5d | ADR-0008, JSON Schema, writers |
| M1-26 | 2d | export command, multi-target, partial failure |
| M1-27 | 3d | Coverage to 80%, fetch guard |
| M1-28 | 1d | Live checklist on 4 platforms, NFR-5 |
| M1-29 | 2d | User docs, ADR-0006, release |
| **Total** | **40d** | ~8 weeks at 5d/week; spikes (4.5d) are on the critical path |

## Success Criteria

- [ ] S1–S4 resolved (or explicitly marked unverified with a fallback); requirements §8/§10 and ADR-0003 updated
- [ ] Real Spotify login works in loopback, `--no-browser`, and `--manual` modes on Linux, WSL, macOS, Windows
- [ ] Tokens refresh transparently, including rotation; a revoked grant exits 3 with a re-login hint
- [ ] Missing Premium produces the FR-AUTH-2 message; a missing scope names the scope (FR-AUTH-5)
- [ ] `search`, `playlist list|show|create|remove`, `export` (playlists and `--liked`) work against live Spotify
- [ ] Every command supports `--help`, `--json`, `--quiet`; exit codes match CLI-4; data-changing commands support `--dry-run`
- [ ] `sple playlist list --quiet | sple export - -o dir/` works (CLI-3)
- [ ] Not-owned playlists fail early with the workaround message; ambiguous names exit 2 with the matches listed
- [ ] Canonical JSON validates against the published JSON Schema; CSV opens correctly in a spreadsheet
- [ ] 1,000-track export < 15 s live (NFR-5)
- [ ] ≥ 80% line coverage on core and the Spotify adapter; no real API calls in tests (NFR-6)
- [ ] No core or CLI module imports from `src/providers/spotify/`; every command also runs against the fake provider (PRV-5)
- [ ] No tokens or secrets in logs at any verbosity (CLI-7)
- [ ] User setup docs dry-run by someone who didn't write them

## Open Questions

1. **Test accounts for S2 and S4.** S2 needs a second Spotify account (Free is fine) to own a collaborative playlist. S4 needs a non-Premium account that owns its own Development Mode app. Does the project owner have both? If not, S4 is shipped as *unverified* with a heuristic mapping (403 whose message mentions "premium").
2. **Config file name.** Requirements CLI-6 and FR-AUTH-3 say `config.json`; ADR-0004 decided `.env`. This plan follows ADR-0004. The requirements should be updated to match. Owner to confirm.
3. **`export --all` priority.** FR-EXP-1 (M) shows `--all` in its syntax, and FR-EXP-6 says "`--all` includes it". But FR-EXP-5 (`--all`) is S and scheduled for M2. This plan defers `--all` to M2. Owner to confirm, or move M1-26 scope up (about 1.5d).
4. **FR-AUTH-5 interpretation.** This plan requests the union of M1 scopes at login and checks per command. An alternative is `auth login --read-only` (no modify scopes), which costs about 0.5d. Wanted for M1?
5. **Release version.** Is M1 published to npm as `0.2.0` or `1.0.0`? Is publishing part of M1 at all?
6. **Default output when not a TTY** (M1-8). Tab-separated without headers is proposed. The alternative is to keep tables everywhere and rely on `--json`.
7. **Default `--all` search cap** (100 results) and the flag name `--max-results`: owner to confirm.
8. **CSV formula injection.** Proposed: don't change cell values (values starting with `=`, `+`, `-`, `@` are written as-is), and document the risk. The alternative is a `--csv-safe` flag.
