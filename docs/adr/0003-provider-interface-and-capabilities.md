# ADR 0003: Provider interface and capabilities

- **Status:** Accepted (2026-10-01)
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

The interface is expected to grow as milestones land. Each change to a type, a member, or a capability's allowed values is recorded as a dated amendment at the end of this ADR, and the sections below are kept in sync with the latest amendment. Amendment 1 (M1) adds `parsePlaylistRef`, typed search results, and the `'owned-or-collaborator'` access mode.

## Decision

### 1. Capabilities

One type, `ProviderCapabilities`, in `src/core/provider/capabilities.ts`. The CLI and core read capabilities; they never branch on provider IDs.

```ts
export type ProviderId = 'spotify' | 'youtube-music' | 'fake';

export type ProviderOperation =
  | 'search' | 'resolveTrack' | 'getTrackDetails'
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
  playlistItemsAccess: 'all' | 'owned-only' | 'owned-or-collaborator';       // FR-PL-2, FR-EXP-5
  likedSongs: { read: 'exact' | 'approximate' | 'none'; write: false; readCap?: number };

  // matching (FR-MIG-2)
  isrcSearchMode: 'lookup' | 'filter' | 'none';    // replaces supportsIsrcSearch
  searchReturnsDuration: boolean;                  // false => resolveTrack needs getTrackDetails
  musicAwareSearch: boolean;

  // writing
  canDeletePlaylist: boolean;                      // false => remove = unfollow (FR-PL-4)
  supportsCollaborative: boolean;
  maxTracksPerRequest: number;                     // populatePlaylist batch size
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
  listPlaylists(page: PageRequest): Promise<Page<PlaylistSummary>>;
  getPlaylist(ref: string): Promise<PlaylistSummary>;                                // returns metadata even when !itemsReadable
  getPlaylistTracks(ref: string, page: PageRequest): Promise<Page<CanonicalTrack>>; // throws AccessRestrictedError if !itemsReadable
  getLikedTracks(page: PageRequest): Promise<Page<CanonicalTrack>>;
  createPlaylist(input: { name: string; description?: string; public: boolean; collaborative?: boolean }): Promise<PlaylistSummary>;
  updatePlaylist?(ref: string, patch: { name?: string; description?: string; public?: boolean }): Promise<PlaylistSummary>; // FR-PL-5 (S)
  removePlaylist(ref: string): Promise<{ action: 'deleted' | 'unfollowed' }>;
  resolveTrack(track: CanonicalTrack, opts: { maxCandidates: number }): Promise<MatchCandidate[]>;

  /** Internal: used only by import/migrate (scope note §4.3). Never exposed as a command. */
  populatePlaylist(ref: string, trackRefs: string[], opts: { skipExisting: boolean }): Promise<{ added: string[]; failed: { ref: string; error: string }[] }>;
}
```

### 4. Error handling

Typed errors, mapped to exit codes (CLI-4) in one place in the CLI layer. Adapters throw only these types; the closed set ensures predictable CLI behavior.

| Error | Exit code | Example |
|---|---|---|
| `AuthRequiredError` (incl. missing scope, FR-AUTH-5) | 3 | No token; token lacks `playlist-modify-private` |
| `NotFoundError` | 4 | Unknown playlist ID or ambiguous name with no match |
| `QuotaExhaustedError` / `RateLimitError` (after retries) | 5 | YouTube `quotaExceeded` |
| `AccessRestrictedError` (`reason: 'not-owned' \| 'premium-required' \| …`) | 1 | Spotify non-owned playlist (FR-PL-2) |
| `UsageError` | 2 | `--offset` on a `cursor-forward` provider |

Error types are defined in `src/core/provider/errors.ts` as a closed set. Adapters must catch provider SDK errors and wrap them in one of these types before throwing.

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
