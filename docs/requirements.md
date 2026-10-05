# sple — Requirements

> Status: **Draft v0.3** (2026-10-01). v0.3 incorporates the grill-me review of v0.2. See [§2](#2-users-and-goals) (personas), [§4.1–4.3](#4-functional-requirements) (flags), [§10](#10-open-questions) (spikes), and [§11](#11-milestones) (M2). Open questions and decisions are tracked in §10 and `docs/adr/`.

## 1. Purpose

`sple` is a command-line tool for managing music-streaming playlists. The first release targets **Spotify**: search the catalog, inspect and export playlists to files, and create/edit/remove playlists. The internal design must treat Spotify as *one provider among many* so that later releases can add **YouTube Music**, **Amazon Music**, and others, and migrate playlists between them.

## 2. Users and goals

| Persona | Goal | First delivery |
|---|---|---|
| **Power listener** | Back up their playlists, bulk-edit them faster than the app allows, and script repetitive tasks. | M1 (MVP) |
| **Switcher** | Move their library from Spotify to another service without rebuilding playlists by hand. | M4b (post-MVP) |
| **Developer / scripter** | Pipe `sple` output into other tools (`jq`, spreadsheets, cron jobs). | M1 (MVP) |

Each user runs `sple` locally against **their own account**. `sple` is not a hosted service and has no server component.

**Prerequisite (Spotify):** the user needs an active **Spotify Premium** subscription. Since February 2026, Spotify requires the owner of a Development Mode app to have Premium, and in sple every user owns their own app (FR-AUTH-2). Spotify Free users have no supported path.

## 3. Glossary

- **Provider**: a music service (Spotify, YouTube Music, Amazon Music, …) accessed through a provider adapter.
- **Track ref**: a provider-specific track ID (e.g. `spotify:track:…`).
- **Canonical track**: the provider-neutral description of a track: title, artists, album, duration, known provider refs, and the ISRC *when the source provides it* (optional; see FR-MIG-2).
- **Canonical playlist file**: `sple`'s lossless JSON export format, which other providers can import.
- **Match**: resolving a canonical track to a track ref on a target provider.
- **Owned playlist**: a playlist the logged-in user owns. On Spotify, only owned playlists can have their tracks read (see §8).

## 4. Functional requirements

Priority: **M** = must have (MVP), **S** = should have (MVP if time allows), **L** = later (post-MVP, but the design must leave room for it).

### 4.1 Authentication and accounts (FR-AUTH)

| ID | P | Requirement |
|---|---|---|
| FR-AUTH-1 | M | `sple auth login [--provider spotify] [--no-browser \| --manual]` runs the provider's OAuth flow: Authorization Code with PKCE (S256) and a loopback redirect on `http://127.0.0.1` with a dynamically assigned port. The user registers exactly `http://127.0.0.1/callback` (no port) with the provider; `localhost` is not used (Spotify rejects it). `sple` tries to open the browser (including a WSL-aware opener) and always prints the URL. `--no-browser` only prints the URL. `--manual` is for headless/SSH use: the user completes login in any browser, then pastes the redirected URL (which fails to load) back into the terminal; `sple` checks `state` and exchanges the code with its stored PKCE verifier. No client secret is required or stored for Spotify. **Exception, Google (YouTube):** the user brings their own Google "Desktop app" OAuth client (ID + secret). `sple` uses the same loopback/manual flows with PKCE, and stores the client secret in the user-only config file so it gets long-lived refresh tokens. Google states this secret is not confidential for installed apps. The OAuth device flow is out of scope (§9). |
| FR-AUTH-2 | M | The user supplies their own Spotify app Client ID (via config or env var). The docs explain how to register one and state the prerequisites: the app owner (the user) needs **Spotify Premium**; Spotify allows 1 Development Mode Client ID per developer and 5 users per app, which is enough for personal use. `auth login` turns a failure caused by a missing Premium subscription into a clear message (exact error to be found by spike S4, §10). |
| FR-AUTH-3 | M | Tokens are stored in `tokens.json` in the user's config directory, keyed by provider and versioned (`{ "schemaVersion": 1, "providers": { "spotify": {…}, "youtube-music": {…} } }`). Client IDs and the user's Google client secret live in `config.json`, separate from tokens. Both files are readable only by the user (`0600` on POSIX; on Windows the files sit in the user's profile, so the profile's access rules protect them). Tokens are refreshed automatically. OS keychain storage is not planned. |
| FR-AUTH-4 | M | `sple auth status [--provider X]` shows the logged-in user (display name and ID; Spotify no longer returns email) and granted scopes; without `--provider` it lists every provider. `sple auth logout --provider X \| --all` removes the stored tokens and, where the provider supports it, revokes the grant. Logout keeps the client configuration in `config.json`. Revoking is required for YouTube; YouTube logout also deletes all `sple`-managed YouTube data (match cache, migration state) and tells the user that export files they created are not touched (NFR-9). |
| FR-AUTH-5 | M | `sple` requests only the minimum scopes each command needs, and explains clearly when a command needs a scope that wasn't granted. |
| FR-AUTH-6 | M | Multiple providers can be logged in at the same time (required for migration). One account per provider. Multiple accounts per provider (profiles) are out of scope, but the versioned token file leaves room for them. *(Promoted from L to M on 2026-10-01: the M0 token store must be built this way.)* |

### 4.2 Search (FR-SEARCH)

| ID | P | Requirement |
|---|---|---|
| FR-SEARCH-1 | M | `sple search <query> [--type track\|album\|artist\|playlist]` searches the provider catalog. The default type is `track`. |
| FR-SEARCH-2 | M | Supports `--limit` and pagination (`--offset`, or `--all` with a safety cap counted in results, not pages). `--offset` is available only on providers with offset pagination (`paginationModel`). The page size follows `maxSearchPageSize` (Spotify: 10 since Feb 2026), so `--limit` above it costs several requests. |
| FR-SEARCH-3 | S | Supports field filters where the provider has them (e.g. `artist:`, `album:`, `year:` on Spotify; `isrc:` only if spike S1 confirms it still works). |
| FR-SEARCH-4 | M | Results include IDs, URIs, and URLs, so they can be piped into other commands or tools. |

### 4.3 Playlist management (FR-PL)

| ID | P | Requirement |
|---|---|---|
| FR-PL-1 | M | `sple playlist list [--owned \| --followed] [--filter <substring\|regex>]` lists the current user's playlists: name, ID, track count, owner, an `owned` column, and public/collaborative flags. `--filter` matches by playlist name. |
| FR-PL-2 | M | `sple playlist show <playlist>` lists the tracks in a playlist. `<playlist>` can be an ID, a URI, a URL, or a name. If the name matches multiple playlists, the command fails with exit 2 and lists the ambiguous matches. On Spotify (`playlistItemsAccess` is `owned-or-collaborator`), a playlist whose tracks are not readable (owned by someone else and not collaborative; detected by probing `/items`, 403/404) fails early (exit 1) with a message explaining the restriction and the workaround: copy its tracks into a playlist you own in the provider's app, then use that. |
| FR-PL-3 | M | `sple playlist create <name> [--description] [--public\|--private] [--collaborative]` |
| FR-PL-4 | M | `sple playlist remove <playlist>` removes a playlist from the user's library. `<playlist>` can be an ID, a URI, a URL, or a name; name matching follows FR-PL-2 (exit 2 on ambiguity). On Spotify this is an *unfollow*, because the API cannot delete playlists; Amazon Music and YouTube truly delete. The CLI and docs must say what `remove` does on each provider (`canDeletePlaylist`). |
| FR-PL-5 | S | `sple playlist edit <playlist>` changes the name, description, or visibility. `<playlist>` can be an ID, a URI, a URL, or a name; name matching follows FR-PL-2 (exit 2 on ambiguity). |
| FR-PL-6 | M | Every command that changes data supports `--dry-run`. `playlist remove` asks for confirmation unless `--yes` is passed. |

> **Scope note:** `sple` manages playlists as whole units. It has no commands for editing a playlist's tracks (add, remove, dedupe, reorder), and it never writes likes / saved tracks. The only time `sple` writes tracks is when it fills a newly created playlist during import or migration (FR-EXP-7, FR-MIG); that happens inside the provider adapter and is never exposed as a command.

### 4.4 Export and import (FR-EXP)

| ID | P | Requirement |
|---|---|---|
| FR-EXP-1 | M | `sple export <playlist…\|--all> [-o path] [--format json\|csv]`. Playlists the provider won't let `sple` read (FR-PL-2) fail with the same message as `playlist show`. |
| FR-EXP-2 | M | **JSON (canonical)** is the default format. It is lossless and versioned (`schemaVersion`), and includes `exportedAt`, `source.provider`, playlist metadata, and canonical tracks (title, artists, album, duration, provider refs, added-at, and `isrc` when the source provides it — optional/nullable; Spotify no longer does). This file is the hand-off format for migration. |
| FR-EXP-3 | M | **CSV**: one row per track, for spreadsheets. |
| FR-EXP-4 | — | *(removed; ID kept so references stay stable)* |
| FR-EXP-5 | S | `--all` exports every readable playlist into a directory, one file per playlist, plus an index file. Playlists that can't be read are skipped with a warning (and a count) and listed in the index as `"status": "skipped", "reason": "not-owned"`. |
| FR-EXP-6 | M | `sple export --liked` exports "Liked Songs" (the saved-tracks library) in the same formats as a playlist. `--all` includes it. It needs the `user-library-read` scope on Spotify. On providers where the export is approximate (e.g. YouTube official API: all liked videos, max 5,000), the CLI warns the user. |
| FR-EXP-7 | L | `sple import <file> [--provider X] [--name …]` creates a playlist from a canonical file (or CSV) by matching tracks on the target provider. |
| FR-EXP-8 | M | The canonical JSON schema is documented and published as a JSON Schema file in the repo. The docs state that export files belong to the user and are outside `sple`'s data retention (NFR-9). |

### 4.5 Migration (FR-MIG) — later, but it constrains the design now

| ID | P | Requirement |
|---|---|---|
| FR-MIG-1 | L | `sple migrate --from spotify --to youtube-music [playlist…\|--liked\|--all]`, implemented as export → match → import. `--liked` creates a **private playlist** on the target, named "Liked Songs (from <source>)" by default (`--name` overrides it); it never writes likes. |
| FR-MIG-2 | L | Track matching runs an ordered chain of strategies, skipping those the providers can't support (capabilities): (1) a known ref for the target provider, from the file or the match cache; (2) ISRC, only if the file has one *and* the target supports ISRC search; (3) normalized title + artist + duration tolerance, with a confidence score. Strategy 3 is the main path: no planned provider pair supports ISRC on both sides (Spotify dropped `external_ids` in Feb 2026; YouTube never had ISRC). |
| FR-MIG-3 | L | Produces a **match report** listing matched, low-confidence, and unmatched tracks. Low-confidence matches are handled with flags, e.g. `--min-confidence`, or by accepting or rejecting entries in the report file and re-running. An interactive `--review` mode depends on the interactive-mode evaluation (§10 Q8). |
| FR-MIG-4 | L | Runs are resumable and idempotent: progress is checkpointed to a local state file, so a quota limit or crash doesn't duplicate tracks when the run is resumed. |
| FR-MIG-5 | L | Respects target-provider rate limits and quotas (e.g. YouTube Data API daily units). Estimates the cost before starting and can spread a run across days. |

## 5. Provider abstraction requirements (PRV)

| ID | Requirement |
|---|---|
| PRV-1 | All provider access goes through a `Provider` interface (auth, search, list/get/create/remove playlist, resolve track, and an internal populate-playlist operation used only by import and migration). Core and CLI code never import provider SDKs or call provider endpoints directly. The interface is defined in [ADR-0003](adr/0003-provider-interface-and-capabilities.md). |
| PRV-2 | Providers declare **capabilities** as one `ProviderCapabilities` type, defined in [ADR-0003](adr/0003-provider-interface-and-capabilities.md) (e.g. `canDeletePlaylist`, `isrcSearchMode`, `playlistItemsAccess`, `maxSearchPageSize`, `maxTracksPerRequest`, `quotaModel`, `paginationModel`, `likedSongs`, `supportsRefreshToken`, `userSuppliedClientId`). The CLI checks capabilities and degrades with a clear message instead of failing obscurely. |
| PRV-3 | Providers convert to and from the canonical track/playlist model at the adapter boundary. |
| PRV-4 | Shared infrastructure for every provider: an HTTP client with retry/backoff (honoring `Retry-After`), pagination helpers, a token store, and a rate/quota limiter. |
| PRV-5 | Adding a provider means adding an adapter module plus its registration. No changes to core commands. |
| PRV-6 | MVP ships the Spotify adapter only. A stub/fake provider exists for tests and to prove the abstraction works. |

## 6. CLI behavior (CLI)

Command grammar, output modes, `--json` shapes, error output, stdin input, partial-failure exit codes, logging and progress are specified in [ADR-0007](adr/0007-cli-conventions.md).

| ID | Requirement |
|---|---|
| CLI-1 | Consistent `sple <noun> <verb>` command structure, `--help` on every command, and `--version`. |
| CLI-2 | Output: human-readable tables by default when stdout is a TTY. `--json` gives machine-readable output (one stable shape per command). `--quiet` limits output to IDs only. |
| CLI-3 | Commands that take playlists read them from stdin when `-` is given, so commands can be chained, e.g. `sple playlist list --quiet \| sple export -`. |
| CLI-4 | Meaningful exit codes: 0 success, 1 general error, 2 usage error, 3 auth required, 4 not found, 5 rate limit/quota exhausted. |
| CLI-5 | Global `--provider` flag, defaulting to the configured default provider (Spotify). |
| CLI-6 | Config file in the platform's config dir (e.g. `~/.config/sple/config.json`), overridable with env vars (`SPLE_*`) and flags, in precedence flag > env > file. Tokens are kept in a separate file (FR-AUTH-3). |
| CLI-7 | `--verbose` / `--debug` logging to stderr. Tokens and secrets are never logged. |
| CLI-8 | Progress indicators for long operations, shown only when attached to a TTY. |

## 7. Non-functional requirements (NFR)

| ID | Requirement |
|---|---|
| NFR-1 | **Stack**: TypeScript (strict), Node.js active LTS. Distributed via npm only (`npx sple` / global install). No standalone binaries. |
| NFR-2 | **Platforms**: Linux, macOS, Windows (including WSL). Login works on all of them, and on headless/SSH machines, through the `--no-browser` and `--manual` modes (FR-AUTH-1). Only the first login needs a browser somewhere; after that, refresh tokens let scripts and cron jobs run unattended. |
| NFR-3 | **Security**: no secrets in the repo. PKCE for every provider. No project-owned secrets. A user's own non-confidential Google client secret may be stored, as described in FR-AUTH-1. Tokens and user-supplied client credentials are stored in user-only local files (FR-AUTH-3), with no native keychain dependency. Untrusted API responses are validated at the boundary. |
| NFR-4 | **Reliability**: transient errors (5xx, 429, network) are retried with exponential backoff and jitter. Batch operations report partial failures per item instead of aborting silently. |
| NFR-5 | **Performance**: exporting a 1,000-track playlist finishes in under 15 s on a normal connection (bounded by API pagination). Paginated reads run with bounded concurrency. (Assumes playlist items still come 50 per page on Spotify; spike S3.) |
| NFR-6 | **Testability**: ≥ 80% line coverage on core and adapters. HTTP is mocked with recorded fixtures. Automated tests never call real provider APIs. |
| NFR-7 | **Compliance**: follow each provider's developer terms. No scraping of official apps. Unofficial clients (e.g. for YouTube Music) that violate a provider's terms are never the default: they are separate opt-in providers, show a blocking risk notice, require an acknowledgement before first use, and never activate automatically as a fallback. |
| NFR-8 | **Docs**: technical docs in `docs/`, user docs in `docs/user/` and `README.md`, ADRs in `docs/adr/`. |
| NFR-9 | **Privacy**: publish `docs/PRIVACY.md` covering what data `sple` stores locally (tokens, match caches, migration state), retention, how to revoke and delete it, and that no data is sent to any `sple` server. Retention: `sple`-managed data that holds YouTube data (match cache, migration state) is refreshed or deleted within 30 days, and deleted on YouTube logout. **Export files are the user's own data, created at their request and saved where they choose; they are outside `sple`'s retention and are not tracked or deleted.** Required by the YouTube API ToS; must be in place before the YouTube provider ships (M4a). |

## 8. Known provider constraints

- **Spotify** (checked 2026-10-01 against the [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and [changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026))
  - **Development Mode (since 2026-02-11 for new apps, 2026-03-09 for all):** the app owner needs an active Premium subscription; 1 Client ID per developer; 5 users per app. Extended Quota is restricted to organisations. This is why users bring their own Client ID (FR-AUTH-2) and why Premium is a prerequisite (§2).
  - **Owned and collaborative playlists only:** `GET /playlists/{id}/items` returns tracks only for the user's own and collaborative playlists; other playlists (followed, other users', editorial) return metadata only or an error. Handled by FR-PL-1/2 and FR-EXP-1/5. Spike S2 (2026-10-02) showed that collaborative playlists the user does not own are also readable (200 with items), while followed non-collaborative playlists return 403 on `/items` and editorial playlists 404. Detection: `owner.id !== me.id` plus a probe of `/items` (do not rely on the `collaborative` flag). See [spike report](spikes/M1-spotify-spikes.md).
  - **ISRC:** spike S1 (2026-10-02) showed the `isrc:` search filter works and `external_ids.isrc` is present on search results (5 of 5 test ISRCs), so `isrcSearchMode` is `'filter'`. ISRC remains an optional match field (FR-MIG-2).
  - **Search:** `limit` is at most 10 per page (default 5), and `limit + offset <= 1000` (spike S3).
  - **Page sizes (spike S3):** `/me/playlists` 50, `/me/tracks` 50, `/playlists/{id}/items` 100. Reading 1,000 tracks takes about 2-4 s sequentially, so NFR-5 is feasible.
  - **Premium detection (spike S4, unverified):** the exact error for an app owner without Premium was not observed. Fallback: a 403 whose `error.message` matches `/premium/i` is treated as Premium required (FR-AUTH-2).
  - **Endpoint changes:** `/playlists/{id}/tracks` → `/playlists/{id}/items` (response field `track` → `item`, request parameter `tracks` → `items`); create playlist uses `POST /me/playlists` (`POST /users/{id}/playlists` was removed); unfollowing a playlist uses `DELETE /me/library` with the playlist URI; batch `GET /tracks`, `GET /users/{id}`, and `GET /users/{id}/playlists` were removed. `GET /me` no longer returns `email`, `country`, or `product`. `GET /me/tracks` (Liked Songs) still works.
  - Recommendations, audio features, and similar endpoints have been unavailable to new apps since late 2024.
  - Playlists cannot be deleted, only unfollowed.
  - **Redirect URIs** ([docs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)): `localhost` is not allowed; loopback must be `http://127.0.0.1` or `http://[::1]`. A loopback URI registered without a port accepts a dynamic port in the authorization request.
  - **Terms:** the [Developer Policy](https://developer.spotify.com/policy) §III.9 forbids transferring data to another service "except for the purpose of enabling a user to transfer their personal data, or the metadata of the user's playlists to another service". User-driven migration (FR-MIG) is therefore allowed.
- **Amazon Music** (not planned; **blocked**, see [ADR-0001](adr/0001-amazon-music-provider.md))
  - **Access:** both API versions (V1 and the V2 preview) are closed beta. Amazon has said it is not onboarding new clients and has published no eligibility criteria or timeline. Applying early does not remove this external blocker; the application is optional.
  - **ToS:** the Amazon Music Program Requirements forbid integrating the service with third-party music services, and require Amazon to certify a product before it is distributed. This conflicts with FR-MIG-1 using Amazon as a migration target.
  - **Auth:**
    - Amazon must enable each client's security profile, so users cannot bring their own client ID. FR-AUTH-2 does not apply to Amazon.
    - Login with Amazon supports PKCE, but without a client secret it issues no refresh token. That conflicts with FR-AUTH-3 and breaks long migrations.
    - Redirect URIs must be HTTPS; whether a loopback redirect is allowed is undocumented.
  - **Capabilities** (verified on paper):
    - Supported: search, list playlists, get playlist tracks, create a playlist, add tracks (V2: 100 per request), truly delete a playlist, and read liked/library tracks.
    - ISRC works only as a search filter, not as a direct lookup.
    - Rate limits are per second and unpublished; there is no daily quota. Throttling returns 429 with no documented `Retry-After`.
    - Pagination is forward-only cursors, so `--offset` cannot be supported.
- **YouTube Music** (next planned provider, M4a/M4b; official API only, see [ADR-0002](adr/0002-youtube-music-provider.md))
  - There is no official YouTube Music API. The two options are the official YouTube Data API v3 and an unofficial client.
  - **Official Data API v3 quota:**
    - Since 2026-06-01, `search.list` has its own cap of 100 calls/day. Everything else shares 10,000 units/day.
    - Writes cost 50 units each, with no batching: `playlistItems.insert`, `playlists.insert/delete`.
    - Net effect: about **100 new tracks/day**, limited by searches. That is about 10 days for 1,000 tracks.
    - Raising the quota requires a compliance audit that a personal project is unlikely to pass.
  - **Official Data API v3 auth:**
    - Users bring their own Google "Desktop" OAuth client and log in through a loopback redirect with PKCE.
    - Desktop clients come with a `client_secret` that Google says is not confidential.
    - Apps left in "Testing" have refresh tokens that expire after 7 days, plus an unverified-app warning and a 100-user cap.
  - **No ISRC:** neither option exposes ISRCs, so matching relies on title + artist + duration only, with a risk of matching music videos or covers.
  - **Liked Songs:** export through the official API is approximate. It returns all liked videos (music mixed with non-music), capped at 5,000.
  - **Deleting playlists:** YouTube can truly delete them (`canDeletePlaylist=true`).
  - **YouTube API terms:**
    - Data may be stored for at most 30 days without a refresh, so match caches need a TTL of 30 days or less (user-created export files excepted; NFR-9).
    - Logout must revoke access and delete stored data.
    - A published privacy policy is required (NFR-9).
  - **Auth decision (2026-10-01):** each user brings their own Google Desktop OAuth client. `sple` uses the loopback flow with PKCE and stores the user's client secret in order to get refresh tokens. This gives long-lived logins, so multi-day migrations resume without logging in again.
    - Users should set their Google project to "In production" (unverified is fine for personal use). In "Testing", refresh tokens expire after 7 days.
  - **Unofficial clients** (investigated, **not planned**; `youtubei.js` for TS is preferred over Python `ytmusicapi`):
    - They have no quota, but they **violate** YouTube's ToS and API policies. The risk is suspension of the user's Google account.
    - They store a long-lived Google session cookie and break often.
  - Outcome: [ADR-0002](adr/0002-youtube-music-provider.md), official Data API v3 only.

## 9. Out of scope (for now)

- Audio playback, downloading audio, or any DRM circumvention.
- GUI or web UI, and (for now) interactive TUI/pickers; see §10 Q8.
- A hosted multi-user service.
- Recommendation and playlist-generation features.
- Export formats other than JSON and CSV (e.g. M3U, XSPF).
- Editing a playlist's tracks: add, remove, dedupe, reorder, sort, merge, or copy (see the scope note in §4.3).
- Writing likes / saved tracks on any provider (Liked Songs migrate into a playlist; FR-MIG-1).
- Reading tracks of playlists the user doesn't own on Spotify, by any route other than the official API.
- Multiple accounts per provider (profiles).
- The OAuth device flow (e.g. Google "TVs and Limited Input devices"); `--manual` covers headless use.
- Support for Spotify Free accounts.
- Real-time two-way sync between providers. One-shot migration only; incremental sync may come later.

## 10. Open questions and decisions

1. ~~**"Add/remove playlists"**~~ **Resolved (2026-10-01):** create and remove whole playlists only. No track editing.
2. ~~**Export formats**~~ **Resolved (2026-10-01):** JSON and CSV only. No M3U/XSPF.
3. ~~**Liked Songs**~~ **Resolved (2026-10-01):** Liked Songs export is in the MVP (FR-EXP-6). Saved albums are not.
4. ~~**Token storage**~~ **Resolved (2026-10-01):** local user-only file. No OS keychain.
5. ~~**YouTube Music strategy**~~ **Resolved (2026-10-01):**
   - Official YouTube Data API v3 only, for now. No unofficial provider.
   - Google auth uses a user-supplied Desktop OAuth client, and its non-confidential secret is stored to get long-lived refresh tokens (FR-AUTH-1).
   - A privacy policy will be published (NFR-9).
   - User-saved export files are the user's own data and outside the 30-day rule; `sple`-managed caches and state follow it (NFR-9).
6. ~~**Second provider**~~ **Resolved (2026-10-01):** dropped. Amazon Music is blocked (ADR-0001) and is not planned. No other provider is committed beyond YouTube Music.
7. ~~**Distribution**~~ **Resolved (2026-10-01):** npm only.
8. **Interactive mode**: *deferred (2026-10-01)*. `sple` is flag-driven only for now. An interactive TUI or picker (e.g. for reviewing matches) will be evaluated later.
9. ~~**Spotify Premium**~~ **Resolved (2026-10-01):** Premium is a hard prerequisite (§2, FR-AUTH-2).
10. ~~**ISRC**~~ **Resolved (2026-10-01):** optional field; metadata matching is the core strategy (FR-MIG-2).
11. ~~**Non-owned Spotify playlists**~~ **Resolved (2026-10-01):** owned only, with a workaround message (FR-PL-2, FR-EXP-5).
12. ~~**Capabilities schema**~~ **Resolved (2026-10-01):** one type in ADR-0003.
13. ~~**Multi-provider login**~~ **Resolved (2026-10-01):** FR-AUTH-6 promoted to M; one account per provider.
14. ~~**Headless login**~~ **Resolved (2026-10-01):** `--no-browser` and `--manual`; no device flow (FR-AUTH-1).
15. ~~**Liked Songs migration target**~~ **Resolved (2026-10-01):** a private playlist, never likes (FR-MIG-1).
16. ~~**MVP value**~~ **Resolved (grill-me):** M1 (Spotify-only, no migration) is an acceptable first release. Switcher persona is post-MVP, delivered in M4b.
17. ~~**Playlist name matching**~~ **Resolved (grill-me):** ambiguous names (matching multiple playlists) fail with exit 2 and list the matches. Applies to all commands that accept a playlist name (show, remove, edit). Users can use IDs or URIs to bypass ambiguity.
18. ~~**Playlist filtering**~~ **Resolved (grill-me):** use `--owned` and `--followed` flags; drop `--mine`. Add `--filter <substring|regex>` to `playlist list` for name filtering (FR-PL-1). Move playlist-level search capability from FR-SEARCH-5 to FR-PL-1.

### Spikes (verify against the live API before the milestone noted)

| ID | Before | Question | Resolution rule |
|---|---|---|---|
| S1 | M1 | Does Spotify `q=isrc:<ISRC>` still return results for a Development Mode app? Sets `isrcSearchMode` (`filter` or `none`). | **Resolved 2026-10-02:** works; `isrcSearchMode: 'filter'`. [Report](spikes/M1-spotify-spikes.md#s1-isrc-search-filter). |
| S2 | M1 | Can a Development Mode app read the tracks of a playlist where the user is a collaborator but not the owner? Refines `playlistItemsAccess`. | **Resolved 2026-10-02:** yes; `'owned-or-collaborator'` (ADR-0003 Amendment 1). [Report](spikes/M1-spotify-spikes.md#s2-collaborator-access-to-playlist-items). |
| S3 | M1 | Current maximum `limit` on `GET /playlists/{id}/items` and `GET /me/tracks` (NFR-5 assumes 50). | **Resolved 2026-10-02:** 50 / 50 / 100; NFR-5 feasible. [Report](spikes/M1-spotify-spikes.md#s3-page-size-limits). |
| S4 | M1 | What error does a Spotify login or first call produce when the app owner has no Premium? Needed for the FR-AUTH-2 message. | **Unverified 2026-10-02** (no non-Premium app); fallback: 403 with message matching `/premium/i`. [Report](spikes/M1-spotify-spikes.md#s4-premium-detection-unverified). |
| S5–S7 | M4a | YouTube spikes from ADR-0002 §6: `LM` playlist access, Desktop-client token exchange with PKCE and without the secret, daily playlist-creation cap. | Contradicting result → update requirements + ADR-0003 before coding. |

## 11. Milestones

| Milestone | Scope |
|---|---|
| **M0 — Foundations** | Repo tooling, provider interface + capabilities ([ADR-0003](adr/0003-provider-interface-and-capabilities.md)) + fake provider, config, multi-provider token store (FR-AUTH-3/6), HTTP client, ADRs for the stack and canonical model. |
| **M1 — Spotify MVP** | Spikes S1–S4 first. FR-AUTH (M), FR-SEARCH (M), FR-PL (M), FR-EXP (M, including Liked Songs), CLI-1…8. |
| **M2 — Spotify polish** | FR-PL-5 (edit), FR-SEARCH-3 (field filters), FR-EXP-5 (export all), FR-PL-1 `--filter` option. |
| **M3 — Import + matching** | FR-EXP-7, matching engine (strategy chain, metadata matching as the core), match report (tested against the fake provider). |
| **M4a — YouTube Music, read-only** | Spikes S5–S7 first. `docs/PRIVACY.md` (NFR-9) before any YouTube data is stored. Google auth (login/logout with revocation/status), search, `playlist list/show`, export, approximate Liked export. Uses `youtube.readonly` only. |
| **M4b — YouTube Music, writes + migrate** | Create/remove playlists, populate-playlist, quota ledger and cost estimate, resumable `migrate` (FR-MIG). Enables Switcher persona. |
| **Later** | Other providers, unscheduled. |
