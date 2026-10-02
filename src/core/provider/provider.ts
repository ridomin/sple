import type { ProviderCapabilities, ProviderId } from './capabilities.js'

export interface PageRequest {
  limit: number
  offset?: number
  cursor?: string
}

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
}

export interface ProviderAuth {
  login(opts: { mode: 'loopback' | 'no-browser' | 'manual'; scopes: string[] }): Promise<AuthStatus>
  status(): Promise<AuthStatus>
  logout(): Promise<{ revoked: boolean; deletedData: string[] }>
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

  listPlaylists(page: PageRequest): Promise<Page<PlaylistSummary>>
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
  resolveTrack(track: CanonicalTrack, opts: { maxCandidates: number }): Promise<MatchCandidate[]>

  populatePlaylist(
    ref: string,
    trackRefs: string[],
    opts: { skipExisting: boolean }
  ): Promise<{ added: string[]; failed: Array<{ ref: string; error: string }> }>
}
