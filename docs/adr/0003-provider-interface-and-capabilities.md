# ADR 0003: Provider interface and capabilities

- **Status:** Accepted (2026-10-01); amended 2026-10-02 (Amendment 1) and 2026-10-07 (Amendment 2)
- **Date:** 2026-10-01
- **Deciders:** project owner (user); architect (author)
- **Related:** `docs/requirements.md` PRV-1…6, FR-AUTH, FR-PL, FR-EXP, FR-MIG, §8, §10 (spikes S1–S7); ADR 0001 (Amazon Music); ADR 0002 (YouTube Music); ADR 0004 (Token store and config)
- **Supersedes:** the capability types and tables in ADR 0001 ("Capability matrix") and ADR 0002 (§4.1)

## Context

PRV-1 and PRV-2 require every provider to sit behind one `Provider` interface and to declare capabilities that the CLI checks before acting. ADR 0001 and ADR 0002 each proposed a `ProviderCapabilities` type, and the two disagree (field names, the ISRC flag, the shape of the quota model, liked-songs support). The requirements review of 2026-10-01 also found new Spotify restrictions (February 2026 Development Mode changes) that need to be expressed as capabilities:

- tracks can be read only from playlists the user owns;
- search returns at most 10 results per page;
- tracks no longer carry ISRC.

M0 builds these types, so they must be defined in exactly one place.

The interface is expected to grow as milestones land. Each change to a type, a member, or a capability's allowed values is recorded as a dated amendment at the end of this ADR, and the sections below are kept in sync with the latest amendment. Amendment 1 (M1) adds `parsePlaylistRef`, typed search results, and the `'owned-or-collaborator'` access mode. Amendment 2 (2026-10-07, spec review for ports) adds `readPageSize`, `parseTrackRef` and `searchTracks` (replacing `resolveTrack`), defines canonical ref formats, the Spotify scope table, error fields, and fake-provider registration.

This ADR is a language-neutral contract. TypeScript is used as the notation; a port in another language must provide the same members, values and error semantics. Where the TypeScript reference implementation differs, the difference is listed in `docs/requirements.md` §12.

## Decision

### 1. Capabilities

One type, `ProviderCapabilities`, in `src/core/provider/capabilities.ts`. The CLI and core read capabilities; they never branch on provider IDs.

```ts
export type ProviderId = 'spotify' | 'youtube-music' | 'fake';

export type ProviderOperation =
  | 'search' | 'searchTracks' | 'getTrackDetails'
  | 'listPlaylists' | 'getPlaylistItems'
  | 'createPlaylist' | 'updatePlaylist' | 'removePlaylist' | 'populatePlaylist'
  | 'readLiked';

export interface QuotaBucket {
  id: string;                  // e.g. 'units', 'search'
  dailyLimit: number;          // default; user-overridable in config
  resetTimeZone: string;       // IANA, e.g. 'America/Los_Angeles'
}

export interface QuotaCost {
  bucket: string;              // QuotaBucket.id
  amount: number;
  per: 'call' | 'page' | 'item';
  pageSize?: number;           // for per: 'page'
}

export type QuotaModel =
  | { kind: 'rate-limited' }                                        // 429 + Retry-After only
  | { kind: 'daily-buckets'; buckets: QuotaBucket[];
      costs: Partial<Record<ProviderOperation, QuotaCost[]>> }      // YouTube Data API
  | { kind: 'undocumented'; minDelayMs: number; maxBatch: number }; // reserved for NFR-7 opt-in providers; unused today

export interface ProviderCapabilities {
  // identity & policy (NFR-7)
  official: boolean;                               // false => opt-in rules apply
  requiresRiskAcknowledgement: boolean;

  // auth (FR-AUTH)
  userSuppliedClientId: boolean;                   // FR-AUTH-2
  requiresClientSecret: boolean;                   // Google Desktop client: true (FR-AUTH-1)
  supportsRefreshToken: boolean;
  supportsRevocation: boolean;                     // FR-AUTH-4

  // reading
  paginationModel: 'offset' | 'cursor-forward';    // drives --offset (FR-SEARCH-2)
  maxSearchPageSize: number;
  readPageSize: { playlists: number; playlistItems: number; liked: number }; // page size for list/items/liked reads (Amendment 2)
  playlistItemsAccess: 'all' | 'owned-only' | 'owned-or-collaborator';       // FR-PL-2, FR-EXP-5
  likedSongs: { read: 'exact' | 'approximate' | 'none'; write: false; readCap?: number };

  // matching (FR-MIG-2)
  isrcSearchMode: 'lookup' | 'filter' | 'none';    // replaces supportsIsrcSearch
  searchReturnsDuration: boolean;                  // false => searchTracks fetches details (getTrackDetails) to fill durationMs
  musicAwareSearch: boolean;

  // writing
  canDeletePlaylist: boolean;                      // false => remove = unfollow (FR-PL-4)
  supportsCollaborative: boolean;
  maxTracksPerRequest: number;                     // populatePlaylist batch size; writes only, never a read page size
  maxPlaylistSize?: number;

  // limits (PRV-4, FR-MIG-5)
  quotaModel: QuotaModel;
}
```

`likedSongs.write` is the literal type `false`: writing likes is out of scope (requirements §9). Lifting it needs a new ADR.

### 2. HTTP client architecture

Each adapter has its own HTTP client instance, bound to its provider ID at initialization. The HTTP client is **completely internal** to the adapter and is never exposed in the `Provider` interface. This keeps the abstraction clean and allows adapters to evolve their HTTP layer without affecting the CLI or core.

The HTTP client owns:
- **Token refresh:** detects 401 responses, calls the token-store module (see ADR-0004) to refresh, and retries the request transparently.
- **Retry logic:** exponential backoff and jitter for transient errors (5xx, 429, network), honoring `Retry-After` headers (NFR-4).
- **Rate limiting:** respects provider quota/rate limits using the `quotaModel` declared in capabilities.

The `Provider` interface does not expose the HTTP client. The CLI never knows HTTP clients exist.

### 3. Provider interface

```ts
// src/core/provider/provider.ts
export interface PageRequest { limit: number; offset?: number; cursor?: string }
export interface Page<T> { items: T[]; next?: { offset?: number; cursor?: string }; total?: number }

export interface PlaylistSummary {
  ref: string;                 // opaque provider ref accepted by getPlaylist etc. (Spotify: the 22-char playlist ID)
  id: string; name: string; description?: string;
  owner: { id: string; displayName?: string };
  owned: boolean;              // FR-PL-1
  itemsReadable: boolean;      // false when not owned and playlistItemsAccess = 'owned-only', or when the non-owned playlist is not readable (Amendment 1)
  trackCount?: number;
  public?: boolean; collaborative?: boolean; url?: string;
}

export interface CanonicalTrack {
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  isrc?: string | null;        // optional; absent from Spotify since Feb 2026
  refs: Record<string, string>;// providerId -> track ref
  addedAt?: string;            // ISO 8601
}

export type SearchType = 'track' | 'album' | 'artist' | 'playlist';

interface SearchItemBase { id: string; ref: string; url?: string; name: string }
export type SearchItem =                                          // FR-SEARCH-4 (Amendment 1)
  | (SearchItemBase & { type: 'track'; track: CanonicalTrack })
  | (SearchItemBase & { type: 'album'; artists: string[]; releaseDate?: string; trackCount?: number })
  | (SearchItemBase & { type: 'artist' })
  | (SearchItemBase & { type: 'playlist'; owner: { id: string; displayName?: string }; trackCount?: number });

/** Input to searchTracks (Amendment 2). The adapter turns it into its own query syntax; core never builds provider query strings. */
export type TrackQuery =
  | { kind: 'isrc'; isrc: string }                                   // only sent when isrcSearchMode !== 'none'
  | { kind: 'metadata'; title: string; artists: string[]; album?: string; durationMs?: number };

/** One searchTracks result. `ref` is a canonical track ref for this provider (§3.1). */
export interface TrackHit { ref: string; track: CanonicalTrack }

/** The single candidate type, used by the matching engine and the match report (ADR 0009). */
export interface MatchCandidate { ref: string; track: CanonicalTrack; confidence: number; strategy: 'known-ref' | 'isrc' | 'metadata' }

export interface AuthStatus { loggedIn: boolean; user?: { id: string; displayName?: string }; scopes: string[]; expiresAt?: string }

export interface ProviderAuth {
  login(opts: { mode: 'loopback' | 'no-browser' | 'manual'; scopes: string[] }): Promise<AuthStatus>;
  status(): Promise<AuthStatus>;
  logout(): Promise<{ revoked: boolean; deletedData: string[] }>; // FR-AUTH-4
}

export interface Provider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  readonly auth: ProviderAuth;

  search(q: { text: string; type: SearchType }, page: PageRequest): Promise<Page<SearchItem>>;
  /** Returns a provider ref if `input` is an ID, URI, or URL for this provider; otherwise null (caller falls back to name lookup). Pure, no I/O. */
  parsePlaylistRef(input: string): string | null;
  /** Returns the canonical track ref (§3.1) if `input` is a track ID, URI, or URL for this provider; otherwise null. Pure, no I/O (Amendment 2). */
  parseTrackRef(input: string): string | null;
  /** `filter` is applied on PlaylistSummary.owned; a filtered page may hold fewer than `limit` items and omits `total`. */
  listPlaylists(page: PageRequest, filter?: 'owned' | 'followed'): Promise<Page<PlaylistSummary>>;
  getPlaylist(ref: string): Promise<PlaylistSummary>;                                // returns metadata even when !itemsReadable
  getPlaylistTracks(ref: string, page: PageRequest): Promise<Page<CanonicalTrack>>; // throws AccessRestrictedError if !itemsReadable; drops unsupported items, `total` counts all items
  getLikedTracks(page: PageRequest): Promise<Page<CanonicalTrack>>;
  createPlaylist(input: { name: string; description?: string; public: boolean; collaborative?: boolean }): Promise<PlaylistSummary>;
  updatePlaylist?(ref: string, patch: { name?: string; description?: string; public?: boolean }): Promise<PlaylistSummary>; // FR-PL-5 (S)
  removePlaylist(ref: string): Promise<{ action: 'deleted' | 'unfollowed' }>;
  /** Catalog track search for matching (ADR 0009). Returns at most `limit` hits in the provider's relevance order. Durations are filled in when the provider has them (searchReturnsDuration=false => the adapter fetches details). */
  searchTracks(query: TrackQuery, opts: { limit: number }): Promise<TrackHit[]>;

  /** Internal: used only by import/migrate (scope note §4.3). Never exposed as a command. Adds in the given order, in batches of maxTracksPerRequest. */
  populatePlaylist(ref: string, trackRefs: string[], opts: { skipExisting: boolean }): Promise<{ added: string[]; failed: { ref: string; error: string }[] }>;
}
```

`ProviderAuth.login` also receives an optional `interaction` supplied by the CLI (`showAuthorizationUrl(url, mode)`, `promptForRedirectUrl(prompt)`), so adapters never touch stdin, stderr or the browser. `logout` may return a `notice` line for the user (e.g. how to revoke manually). See ADR 0010.

#### 3.1 Canonical refs

Refs are opaque to core, but each adapter produces them in exactly one form, so files written by one implementation are readable by another.

| Provider | Playlist ref (`PlaylistSummary.ref`, `parsePlaylistRef` result) | Track ref (`refs[provider]`, `parseTrackRef` result) | `parsePlaylistRef` / `parseTrackRef` accept |
|---|---|---|---|
| `spotify` | bare 22-char base62 ID | `spotify:track:<22-char id>` | bare ID; `spotify:playlist:<id>` / `spotify:track:<id>`; `http(s)://open.spotify.com/[intl-xx/]playlist\|track/<id>[/][?…][#…]` |
| `youtube-music` | bare playlist ID (`[A-Za-z0-9_-]{13,}`) | bare 11-char video ID (`[A-Za-z0-9_-]{11}`) | bare ID; `http(s)://{www.,m.,music.,}youtube.com/…?list=<id>` (playlists); `…/watch?v=<id>`, `https://youtu.be/<id>` (tracks) |
| `fake` | decimal ID (`[0-9]+`) | `fake:track:<id>` | `fake:playlist:<id>`, bare decimal ID; `fake:track:<id>` |

An ID-shaped input is always treated as an ID. The playlist resolver falls back to name lookup when a **bare** ID is not found (a one-word name can look like an ID); a URI or URL that is not found stays `NotFoundError`.

#### 3.2 Playlist resolution (shared by show, remove, edit, export)

1. `parsePlaylistRef(input)`; if non-null, `getPlaylist(ref)`. On `NotFoundError` with a bare-ID input, continue with step 2; otherwise rethrow.
2. Read every page of `listPlaylists` (cached per process and provider).
3. Exact, case-sensitive name match: one → return it; several → `UsageError` (exit 2) listing each match as `• <name> (id: <id>, owner: <owner>[ (owned)])`.
4. Otherwise the same with a case-insensitive comparison (Unicode lower-case).
5. No match → `NotFoundError` (`resourceType: 'playlist'`, exit 4).

### 4. Error handling

Typed errors, mapped to exit codes (CLI-4) in one place in the CLI layer. Adapters throw only these types; the closed set ensures predictable CLI behavior.

| Error | Fields | Exit code | Example |
|---|---|---|---|
| `ProviderError` (base of all below) | `message` | 1 | Unexpected status, invalid JSON from the provider |
| `AuthRequiredError` (incl. missing scope, FR-AUTH-5) | `reason: 'no-token' \| 'token-expired' \| 'missing-scope' \| 'revoked'`, `scope?` | 3 | No token; token lacks `playlist-modify-private` |
| `NotFoundError` | `resourceType: 'playlist' \| 'track' \| 'user' \| 'other'` | 4 | Unknown playlist ID, or a name with no match |
| `QuotaExhaustedError` | `bucket`, `resetAt?` | 5 | YouTube `quotaExceeded` |
| `RateLimitError` (after retries, ADR 0010) | `retryAfterMs?` | 5 | 429 whose `Retry-After` exceeds the maximum wait |
| `AccessRestrictedError` | `reason: 'not-owned' \| 'premium-required' \| 'region-restricted' \| 'other'` | 1 | Spotify non-owned playlist (FR-PL-2) |
| `UsageError` | — | 2 | `--offset` on a `cursor-forward` provider; ambiguous playlist name |

Error types are defined in `src/core/provider/errors.ts` as a closed set; the CLI maps them to exit codes and messages in one place (ADR 0007 §4). Adapters must catch provider SDK errors and wrap them in one of these types before throwing. Any other error (including a plain runtime error) exits 1.

### 5. Declared capability values

| Capability | Spotify | YouTube Music (Data API v3) | Notes |
|---|---|---|---|
| `official` | true | true | |
| `requiresRiskAcknowledgement` | false | false | |
| `userSuppliedClientId` | true | true | |
| `requiresClientSecret` | false | true | Google Desktop client (FR-AUTH-1) |
| `supportsRefreshToken` | true | true | |
| `supportsRevocation` | false | true | Spotify has no revoke endpoint; logout deletes local tokens and the docs point to the account's Apps page |
| `paginationModel` | `'offset'` | `'cursor-forward'` | YouTube uses `pageToken` |
| `maxSearchPageSize` | **10** | 50 | Spotify Feb 2026 |
| `readPageSize` | `{ playlists: 50, playlistItems: 100, liked: 50 }` | `{ playlists: 50, playlistItems: 50, liked: 50 }` | Spotify: spike S3; YouTube: `maxResults` cap of `playlists.list` / `playlistItems.list` |
| `playlistItemsAccess` | **`'owned-or-collaborator'`** | `'all'` | Spotify: spike S2 (2026-10-02); readability of non-owned playlists is probed at read time |
| `likedSongs` | `{ read: 'exact', write: false }` | `{ read: 'approximate', write: false, readCap: 5000 }` | |
| `isrcSearchMode` | `'filter'` (spike S1, 2026-10-02) | `'none'` | |
| `searchReturnsDuration` | true | false | |
| `musicAwareSearch` | true | false | |
| `canDeletePlaylist` | false (unfollow via `DELETE /me/library`) | true | |
| `supportsCollaborative` | true | false | |
| `maxTracksPerRequest` | 100 (`POST /playlists/{id}/items`) | 1 (`playlistItems.insert`) | |
| `maxPlaylistSize` | 10000 | undefined (handle 403 `playlistContainsMaximumNumberOfVideos`) | |
| `quotaModel` | `{ kind: 'rate-limited' }` | `daily-buckets`, as specified in ADR 0002 §4.1 (minus `writeLiked`) | |

The fake provider defaults to `paginationModel: 'offset'`, `maxSearchPageSize: 50`, `readPageSize: { 50, 100, 50 }`, `maxTracksPerRequest: 100`, `playlistItemsAccess: 'all'`, `isrcSearchMode: 'none'`, `canDeletePlaylist: true`, `supportsCollaborative: true`, `likedSongs: { read: 'exact', write: false }`, `quotaModel: { kind: 'rate-limited' }`, and every value can be overridden by tests.

Amazon Music has no declared values: the provider is rejected (ADR 0001). The fields it needed (`paginationModel`, `isrcSearchMode`, `supportsRefreshToken`, `userSuppliedClientId`) are kept because Spotify and YouTube use them too.

## Alternatives considered

- **Keep each ADR's type and reconcile during implementation.** Rejected: the implementer would have to make design decisions, and the two shapes conflict.
- **Flat boolean flags only** (ADR 0001 style). Rejected: they can't express quota buckets and costs (FR-MIG-5) or approximate liked-songs reads.
- **Branching on provider ID in the CLI.** Rejected: violates PRV-5 (adding a provider must not change core commands).
- **Expose the HTTP client in the `Provider` interface.** Rejected: breaks the abstraction boundary. HTTP client details should be internal to each adapter. The CLI never needs direct access.

## Consequences

- M0 implements these types, a fake provider that declares them (with configurable values so tests can cover `owned-only`, `cursor-forward`, `daily-buckets`, …), and the error-to-exit-code mapping.
- M0 also implements the HTTP client base class (used by all adapters), token-store module, and config/paths module (see ADR-0004).
- The capability tables in ADR 0001 and ADR 0002 are historical; this ADR is the source of truth.
- Spike results S1 and S2 are recorded in Amendment 1.
- Search results are typed (`SearchItem`, a union discriminated on `type`), so the CLI renders and serializes them without casts or provider knowledge. Adapters map provider payloads to `SearchItem` themselves; a new search type is an amendment.
- Playlist reference parsing (IDs, URIs, URLs) lives in each adapter's `parsePlaylistRef`, so the core resolver never branches on provider ID (PRV-5).
- New capabilities need an amendment to this ADR.
- Token refresh happens transparently in each adapter's HTTP client; the `Provider` interface and CLI are unaware of refresh logic or token file I/O.

## Sources

- Spotify February 2026 migration guide: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- Spotify February 2026 changelog: https://developer.spotify.com/documentation/web-api/references/changes/february-2026
- YouTube values: ADR 0002 and the sources cited there.

## Amendment 1 (M1)

- **Date:** 2026-10-02
- **Spike report:** [docs/spikes/M1-spotify-spikes.md](../spikes/M1-spotify-spikes.md)

| Change | Why |
|---|---|
| `isrcSearchMode` for Spotify confirmed as `'filter'` (S1) | `isrc:` search returned the expected track for 5 of 5 ISRCs, with `external_ids.isrc` present. Value confirmed, not changed. |
| `playlistItemsAccess` gains `'owned-or-collaborator'`; Spotify changes from `'owned-only'` to it (S2) | Collaborative playlists the user does not own return 200 with items; followed non-collaborative return 403 and editorial 404. This is a type amendment (new union member). |
| Readability detection rule | A non-owned playlist (`owner.id !== me.id`) is probed on `/items`; 403/404 means not readable (`itemsReadable: false`). The `collaborative` flag is not relied on. This refines the `itemsReadable` comment in §3. |
| S3 limits recorded (50 / 50 / 100 / 10, search `limit + offset <= 1000`) | No capability change; `maxSearchPageSize` stays 10. |
| S4 unverified | No capability change. Fallback: 403 with message matching `/premium/i` maps to `AccessRestrictedError` (`reason: 'premium-required'`). |

### Interface additions (M1-7, 2026-10-02)

| Change | Why |
|---|---|
| New member `parsePlaylistRef(input: string): string \| null` | Users pass playlists as IDs, URIs, URLs, or names (FR-PL-2, FR-PL-4). Ref formats are provider-specific and the core must not branch on provider ID (PRV-5). Pure, no I/O; null means "fall back to name lookup". An ID-shaped input is always treated as an ID. Spotify accepts a bare 22-char base62 ID, `spotify:playlist:<id>`, and `https://open.spotify.com/[intl-xx/]playlist/<id>[?…]`, and returns the bare ID. |
| `search` returns `Page<SearchItem>` instead of `Page<unknown>`; new `SearchType` alias | FR-SEARCH-4 needs per-type columns and a stable `--json` shape. A discriminated union keeps the CLI free of casts and provider knowledge. |
| `StoredToken` gains optional `displayName?: string` | `auth status` can show the account name offline. Additive, so `tokens.json` stays `schemaVersion: 1` (ADR-0004); tokens without it still load. |
| `PlaylistSummary.ref` comment clarified as an opaque provider ref | The ref returned by `parsePlaylistRef` is the one passed to `getPlaylist`; for Spotify that is the bare playlist ID, not a `spotify:playlist:` URI. |
| `getPlaylist` returns metadata for non-readable playlists; `getPlaylistTracks` throws `AccessRestrictedError` (`reason: 'not-owned'`) | Matches the existing §3 contract (`itemsReadable`). The fake provider previously threw from `getPlaylist` under `owned-only`; it now follows the contract, and for `'owned-or-collaborator'` uses its `collaborative` flag as the read-time signal. |

Implemented in code: `'owned-or-collaborator'` in `src/core/provider/capabilities.ts`; Spotify values in `src/providers/spotify/index.ts`; fake provider updated.

## Amendment 2 (spec review for ports)

- **Date:** 2026-10-07
- **Why:** make this ADR complete enough to implement `sple` in another language, and record decisions taken in the review. Differences in the TypeScript code are tracked in `docs/requirements.md` §12.

| Change | Why |
|---|---|
| New capability `readPageSize: { playlists, playlistItems, liked }` | Reads used `maxTracksPerRequest` (the write batch size) as their page size. On YouTube that is 1, so a 200-track playlist took 200 requests. `maxTracksPerRequest` is now for writes only. |
| `resolveTrack` replaced by `searchTracks(query: TrackQuery, { limit }) → TrackHit[]`; `ProviderOperation` `'resolveTrack'` renamed `'searchTracks'` | Core owns the strategy chain and scoring (ADR 0009); adapters own query syntax. Core no longer writes `isrc:<code>` or `"<title> <artist>"` strings into `search`. |
| One `MatchCandidate` type (the one in §3) | The matching engine had its own `{ trackRef, confidence, metadata }` shape. The match report uses this type (ADR 0009 Amendment 1). |
| New member `parseTrackRef` and canonical ref formats (§3.1) | CSV import infers the source provider from its refs (ADR 0008 Amendment 1), and ports must write the same refs. YouTube refs are bare IDs, not `watch?v=` URLs. |
| Playlist resolution rules (§3.2) | Case-sensitive then case-insensitive name match and the bare-ID fallback were implemented but not specified. |
| `listPlaylists` takes an optional `filter` | Already in the code (M1); used by `--owned` / `--followed`. |
| `getPlaylistTracks` drops unsupported items (local files, episodes, unavailable) and reports the full count in `total` | Decision of the review: positions number exported tracks only and `unsupportedItems` stays empty for now (ADR 0007 Amendment 1, ADR 0008 Amendment 1). |
| Error fields in §4 | Needed to reproduce messages and exit-code priority. |
| Spotify readability: a non-owned playlist is readable when `GET /playlists/{id}` includes an `items` key; a later 403/404 on `/items` turns it into `AccessRestrictedError('not-owned')` | Spike S2 recorded both signals; the `items` key avoids one extra request per playlist and works for whole `listPlaylists` pages. The `collaborative` flag is still not used. |
| Fake provider registration | The fake provider (`id: 'fake'`) is required for tests but is registered in the CLI only when `SPLE_ENABLE_FAKE_PROVIDER=1` (ADR 0004 Amendment 1). It does not appear in help, `auth status`, or "valid providers" messages otherwise. |
| YouTube values unchanged | The TypeScript YouTube adapter is an unfinished M4 preview; its differences from §5 are listed in requirements §12. |

### Spotify scope table (FR-AUTH-5)

Login requests the union of the table: `playlist-read-private playlist-read-collaborative user-library-read playlist-modify-public playlist-modify-private`. Before each call the adapter checks that a token is stored (else `AuthRequiredError('no-token')`) and that every listed scope was granted (else `AuthRequiredError('missing-scope', scope)` naming the first missing one, in table order).

| Operation | Scopes required |
|---|---|
| `search` | none (login still required) |
| `listPlaylists` | `playlist-read-private`, `playlist-read-collaborative` |
| `getPlaylist`, `getPlaylistTracks` | `playlist-read-private` |
| `getLikedTracks` | `user-library-read` |
| `createPlaylist` | public: `playlist-modify-public`; private: `playlist-modify-private`; collaborative: both |
| `removePlaylist` | `playlist-modify-public`, `playlist-modify-private` (visibility is not known before the call) |
| `populatePlaylist` | `playlist-modify-public`, `playlist-modify-private` |
| `searchTracks` | none (login still required) |

### Spotify endpoints used

| Operation | Request |
|---|---|
| `search` | `GET /v1/search?q=&type=&limit=(≤10)&offset=`; `next` from the section's `next` URL (or `offset + count < total`) |
| `searchTracks` | as `search` with `type=track`: `q=isrc:<ISRC>`, or `q=<title> <first artist>` (plain text, as M3 used) |
| `listPlaylists` | `GET /v1/me/playlists?limit=(≤50)&offset=` |
| `getPlaylist` | `GET /v1/playlists/{id}` |
| `getPlaylistTracks` | `GET /v1/playlists/{id}/items?limit=(≤100)&offset=`; items with a `null` track, `is_local: true`, or `type: 'episode'` are dropped |
| `getLikedTracks` | `GET /v1/me/tracks?limit=(≤50)&offset=`; `addedAt` from `added_at` |
| `createPlaylist` | `POST /v1/me/playlists` `{ name, description, public, collaborative }`; public + collaborative is a `UsageError` |
| `removePlaylist` | `DELETE /v1/me/library?uris=spotify:playlist:<id>` → `{ action: 'unfollowed' }` |
| `populatePlaylist` | `POST /v1/playlists/{id}/items` with the track URIs (body field per the February 2026 reference; not yet implemented, see requirements §12), at most 100 per request, in order |

Track mapping: `title` = `name` (`"(untitled)"` if empty), `artists` = artist names (`["Unknown Artist"]` if none), `album` = `album.name`, `durationMs` = `duration_ms`, `isrc` = `external_ids.isrc` when present, otherwise `null`, `refs.spotify` = `uri`.
