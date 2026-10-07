import type { ProviderCapabilities, ProviderId } from './capabilities.js'

export interface PageRequest {
  limit: number
  offset?: number
  cursor?: string
}

/**
 * Filter for `listPlaylists` (FR-PL-1).
 * - `owned`: only playlists whose owner is the current user
 * - `followed`: only playlists the user follows but does not own (S2 treats these as a distinct kind)
 * Omitted: every playlist in the user's library.
 */
export type PlaylistFilter = 'owned' | 'followed'

export interface Page<T> {
  items: T[]
  next?: { offset?: number; cursor?: string }
  total?: number
}

export interface PlaylistSummary {
  ref: string
  id: string
  name: string
  description?: string
  owner: { id: string; displayName?: string }
  owned: boolean
  itemsReadable: boolean
  trackCount?: number
  public?: boolean
  collaborative?: boolean
  url?: string
}

export interface CanonicalTrack {
  title: string
  artists: string[]
  album?: string
  durationMs?: number
  isrc?: string | null
  refs: Record<string, string>
  addedAt?: string
}

/** Input to searchTracks. The adapter turns it into its own query syntax; core never builds provider query strings (ADR-0003 A2). */
export type TrackQuery =
  | { kind: 'isrc'; isrc: string }
  | { kind: 'metadata'; title: string; artists: string[]; album?: string; durationMs?: number }

/** One searchTracks result. `ref` is this provider's track ref. */
export interface TrackHit {
  ref: string
  track: CanonicalTrack
}

/** The single candidate type, used by the matching engine and the match report (ADR-0009). */
export interface MatchCandidate {
  ref: string
  track: CanonicalTrack
  confidence: number
  strategy: 'known-ref' | 'isrc' | 'metadata'
}

export type SearchType = 'track' | 'album' | 'artist' | 'playlist'

export interface SearchItemBase {
  id: string
  ref: string
  url?: string
  name: string
}

export type SearchItem =
  | (SearchItemBase & { type: 'track'; track: CanonicalTrack })
  | (SearchItemBase & { type: 'album'; artists: string[]; releaseDate?: string; trackCount?: number })
  | (SearchItemBase & { type: 'artist' })
  | (SearchItemBase & {
      type: 'playlist'
      owner: { id: string; displayName?: string }
      trackCount?: number
    })

export interface AuthStatus {
  loggedIn: boolean
  user?: { id: string; displayName?: string }
  scopes: string[]
  expiresAt?: string
  /** Set by login: requested scopes the user did not grant (e.g. an unticked consent checkbox). */
  missingScopes?: string[]
}

export type LoginMode = 'loopback' | 'no-browser' | 'manual'

/**
 * User-facing side of an interactive login, supplied by the CLI so that
 * provider adapters never touch stdin/stderr or the browser directly.
 */
export interface LoginInteraction {
  /**
   * Called once the authorization URL is ready, before waiting for the
   * redirect. The CLI prints it to stderr and, in `loopback` mode, opens a browser.
   */
  showAuthorizationUrl(url: string, mode: LoginMode): Promise<void>
  /** `manual` mode: read the pasted redirect URL (one line). */
  promptForRedirectUrl(prompt: string): Promise<string>
}

export interface ProviderAuth {
  login(opts: { mode: LoginMode; scopes: string[]; interaction?: LoginInteraction }): Promise<AuthStatus>
  status(): Promise<AuthStatus>
  /**
   * Delete stored tokens and, where supported, revoke the grant. `notice` is
   * an optional provider-specific line for the user (e.g. how to revoke manually).
   */
  logout(): Promise<{ revoked: boolean; deletedData: string[]; notice?: string }>
}

export interface Provider {
  readonly id: ProviderId
  readonly displayName: string
  readonly capabilities: ProviderCapabilities
  readonly auth: ProviderAuth

  search(q: { text: string; type: SearchType }, page: PageRequest): Promise<Page<SearchItem>>

  /**
   * Returns a provider ref if `input` is an ID, URI, or URL for this provider;
   * otherwise null (caller falls back to name lookup). Pure, no I/O.
   */
  parsePlaylistRef(input: string): string | null
  /** The canonical track ref (ADR-0003 §3.1) if `input` is a track ID, URI or URL for this provider; otherwise null. Pure, no I/O. */
  parseTrackRef(input: string): string | null

  /**
   * Lists the user's playlists. With a `filter`, a page may hold fewer than
   * `page.limit` items; `next` still follows the unfiltered offsets, and
   * `total` is omitted because the provider total counts unfiltered items.
   */
  listPlaylists(page: PageRequest, filter?: PlaylistFilter): Promise<Page<PlaylistSummary>>
  getPlaylist(ref: string): Promise<PlaylistSummary>
  getPlaylistTracks(ref: string, page: PageRequest): Promise<Page<CanonicalTrack>>
  getLikedTracks(page: PageRequest): Promise<Page<CanonicalTrack>>

  createPlaylist(input: {
    name: string
    description?: string
    public: boolean
    collaborative?: boolean
  }): Promise<PlaylistSummary>

  updatePlaylist?(
    ref: string,
    patch: { name?: string; description?: string; public?: boolean }
  ): Promise<PlaylistSummary>

  removePlaylist(ref: string): Promise<{ action: 'deleted' | 'unfollowed' }>
  /** Catalog track search for matching (ADR-0009). At most `limit` hits, in the provider's relevance order. */
  searchTracks(query: TrackQuery, opts: { limit: number }): Promise<TrackHit[]>

  populatePlaylist(
    ref: string,
    trackRefs: string[],
    opts: { skipExisting: boolean }
  ): Promise<{ added: string[]; failed: Array<{ ref: string; error: string }> }>
}
