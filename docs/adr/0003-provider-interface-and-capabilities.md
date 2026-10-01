# ADR 0003: Provider interface and capabilities

- **Status:** Accepted (2026-10-01)
- **Date:** 2026-10-01
- **Deciders:** project owner (user); architect (author)
- **Related:** `docs/requirements.md` PRV-1…6, FR-AUTH, FR-PL, FR-EXP, FR-MIG, §8, §10 (spikes S1–S7); ADR 0001 (Amazon Music); ADR 0002 (YouTube Music)
- **Supersedes:** the capability types and tables in ADR 0001 ("Capability matrix") and ADR 0002 (§4.1)

## Context

PRV-1 and PRV-2 require every provider to sit behind one `Provider` interface and to declare capabilities that the CLI checks before acting. ADR 0001 and ADR 0002 each proposed a `ProviderCapabilities` type, and the two disagree (field names, the ISRC flag, the shape of the quota model, liked-songs support). The requirements review of 2026-10-01 also found new Spotify restrictions (February 2026 Development Mode changes) that need to be expressed as capabilities:

- tracks can be read only from playlists the user owns;
- search returns at most 10 results per page;
- tracks no longer carry ISRC.

M0 builds these types, so they must be defined in exactly one place.

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
  playlistItemsAccess: 'all' | 'owned-only';       // FR-PL-2, FR-EXP-5
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

### 2. Provider interface

```ts
// src/core/provider/provider.ts
export interface PageRequest { limit: number; offset?: number; cursor?: string }
export interface Page<T> { items: T[]; next?: { offset?: number; cursor?: string }; total?: number }

export interface PlaylistSummary {
  ref: string;                 // provider-qualified, e.g. 'spotify:playlist:…'
  id: string; name: string; description?: string;
  owner: { id: string; displayName?: string };
  owned: boolean;              // FR-PL-1
  itemsReadable: boolean;      // false when playlistItemsAccess = 'owned-only' and !owned
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

  search(q: { text: string; type: 'track' | 'album' | 'artist' | 'playlist' }, page: PageRequest): Promise<Page<unknown>>;
  listPlaylists(page: PageRequest): Promise<Page<PlaylistSummary>>;
  getPlaylist(ref: string): Promise<PlaylistSummary>;
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

Typed errors, mapped to exit codes (CLI-4) in one place in the CLI layer:

| Error | Exit code | Example |
|---|---|---|
| `AuthRequiredError` (incl. missing scope, FR-AUTH-5) | 3 | No token; token lacks `playlist-modify-private` |
| `NotFoundError` | 4 | Unknown playlist ID or ambiguous name with no match |
| `QuotaExhaustedError` / `RateLimitError` (after retries) | 5 | YouTube `quotaExceeded` |
| `AccessRestrictedError` (`reason: 'not-owned' \| 'premium-required' \| …`) | 1 | Spotify non-owned playlist (FR-PL-2) |
| `UsageError` | 2 | `--offset` on a `cursor-forward` provider |

### 3. Declared values

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
| `playlistItemsAccess` | **`'owned-only'`** | `'all'` | Spotify: pending spike S2 (collaborators) |
| `likedSongs` | `{ read: 'exact', write: false }` | `{ read: 'approximate', write: false, readCap: 5000 }` | |
| `isrcSearchMode` | `'filter'` (**pending S1**; `'none'` if it fails) | `'none'` | |
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

## Consequences

- M0 implements these types, a fake provider that declares them (with configurable values so tests can cover `owned-only`, `cursor-forward`, `daily-buckets`, …), and the error-to-exit-code mapping.
- The capability tables in ADR 0001 and ADR 0002 are historical; this ADR is the source of truth.
- Spike results S1 and S2 may change two Spotify values before M1 ships; that is a value change, not a type change.
- New capabilities need an amendment to this ADR.

## Sources

- Spotify February 2026 migration guide: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- Spotify February 2026 changelog: https://developer.spotify.com/documentation/web-api/references/changes/february-2026
- YouTube values: ADR 0002 and the sources cited there.
