import type {
  Provider,
  PlaylistSummary,
  CanonicalTrack,
  MatchCandidate,
  Page,
  PageRequest,
  PlaylistFilter,
  ProviderAuth,
  SearchItem,
  SearchType,
} from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import type { ProviderId } from '../../core/provider/capabilities.js'
import {
  NotFoundError,
  AccessRestrictedError,
  QuotaExhaustedError,
} from '../../core/provider/errors.js'
import { loadTokens, saveTokens, deleteTokens } from '../../core/config/token-store.js'
import type { StoredToken } from '../../core/config/token-store.js'

export interface FakePlaylist {
  id: string
  name: string
  description?: string
  owner: string
  public: boolean
  collaborative: boolean
  trackIds: string[]
}

export interface FakeTrack {
  id: string
  title: string
  artists: string[]
  album?: string
  duration: number
  isrc?: string
}

export interface FakeProviderConfig {
  capabilities?: Partial<ProviderCapabilities>
  initialPlaylists?: FakePlaylist[]
  initialTracks?: FakeTrack[]
  userId?: string
  configDir?: string
}

let loginCounter = 0

const FAKE_PLAYLIST_URI = /^fake:playlist:([A-Za-z0-9_-]+)$/
const FAKE_PLAYLIST_ID = /^[0-9]+$/

export class FakeProvider implements Provider {
  readonly id: ProviderId = 'fake'
  readonly displayName = 'Fake Provider'

  private playlists: Map<string, FakePlaylist> = new Map()
  private tracks: Map<string, FakeTrack> = new Map()
  private userId: string
  private nextPlaylistId = 1
  private quotaBucket = 1000
  private configDir?: string

  capabilities: ProviderCapabilities
  auth: ProviderAuth

  constructor(config: FakeProviderConfig = {}) {
    this.userId = config.userId ?? 'fake-user'
    this.configDir = config.configDir

    // Build capabilities with proper types
    const caps: any = {
      canDeletePlaylist: config.capabilities?.canDeletePlaylist ?? true,
      canCreatePlaylist: true,
      isrcSearchMode: config.capabilities?.isrcSearchMode ?? 'none',
      playlistItemsAccess: config.capabilities?.playlistItemsAccess ?? 'all',
      paginationModel: config.capabilities?.paginationModel ?? 'offset',
      quotaModel: config.capabilities?.quotaModel ?? 'undocumented',
      maxSearchPageSize: config.capabilities?.maxSearchPageSize ?? 50,
      maxTracksPerRequest: config.capabilities?.maxTracksPerRequest ?? 100,
      likedSongs: config.capabilities?.likedSongs ?? { read: 'exact', write: false },
      supportsRefreshToken: config.capabilities?.supportsRefreshToken ?? false,
      userSuppliedClientId: false,
    }
    this.capabilities = caps as ProviderCapabilities

    this.auth = {
      login: async (opts) => {
        const scopes = opts.scopes.length > 0 ? opts.scopes : ['all']
        const token: StoredToken = {
          accessToken: `fake-access-token-${Date.now()}-${++loginCounter}`,
          refreshToken: `fake-refresh-token-${Date.now()}`,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          scopes,
          userId: this.userId,
          displayName: 'Fake User',
          grantedAt: new Date().toISOString(),
        }
        await saveTokens('fake', token, this.configDir)
        return {
          loggedIn: true,
          user: { id: this.userId, displayName: 'Fake User' },
          scopes,
          expiresAt: token.expiresAt,
        }
      },
      logout: async () => {
        await deleteTokens('fake', this.configDir)
        return { revoked: true, deletedData: ['access_token', 'refresh_token'] }
      },
      status: async () => {
        const token = await loadTokens('fake', this.configDir)
        if (!token) {
          return {
            loggedIn: false,
            scopes: [],
          }
        }
        return {
          loggedIn: true,
          user: { id: token.userId, displayName: token.displayName ?? token.userId },
          scopes: token.scopes,
          expiresAt: token.expiresAt,
        }
      },
    } as ProviderAuth

    // Initialize with provided data
    if (config.initialTracks) {
      for (const track of config.initialTracks) {
        this.tracks.set(track.id, track)
      }
    }

    if (config.initialPlaylists) {
      for (const playlist of config.initialPlaylists) {
        this.playlists.set(playlist.id, playlist)
        this.nextPlaylistId = Math.max(
          this.nextPlaylistId,
          parseInt(playlist.id, 10) + 1
        )
      }
    }
  }

  /**
   * Fake ref grammar: `fake:playlist:<id>` (id = [A-Za-z0-9_-]+) or a bare
   * numeric ID (the shape createPlaylist generates). Anything else is treated
   * as a name. Pure; does not check whether the playlist exists.
   */
  parsePlaylistRef(input: string): string | null {
    const trimmed = input.trim()
    const uri = FAKE_PLAYLIST_URI.exec(trimmed)
    if (uri) return uri[1]
    if (FAKE_PLAYLIST_ID.test(trimmed)) return trimmed
    return null
  }

  async search(
    q: { text: string; type: SearchType },
    page: PageRequest
  ): Promise<Page<SearchItem>> {
    const limit = page.limit ?? this.capabilities.maxSearchPageSize
    const offset = page.offset ?? 0
    const needle = q.text.toLowerCase()
    const matches = (value: string): boolean => value.toLowerCase().includes(needle)

    let results: SearchItem[]

    switch (q.type) {
      case 'track':
        results = Array.from(this.tracks.values())
          .filter((t) => matches(t.title) || t.artists.some(matches))
          .map((t) => ({
            type: 'track',
            id: t.id,
            ref: t.id,
            name: t.title,
            track: this.trackToCanonical(t),
          }))
        break

      case 'album': {
        const albums = new Map<string, { artists: Set<string>; trackCount: number }>()
        for (const t of this.tracks.values()) {
          if (!t.album || !(matches(t.album) || t.artists.some(matches))) continue
          const entry = albums.get(t.album) ?? { artists: new Set<string>(), trackCount: 0 }
          t.artists.forEach((a) => entry.artists.add(a))
          entry.trackCount++
          albums.set(t.album, entry)
        }
        results = Array.from(albums, ([name, a]) => ({
          type: 'album',
          id: `album:${name}`,
          ref: `album:${name}`,
          name,
          artists: Array.from(a.artists),
          trackCount: a.trackCount,
        }))
        break
      }

      case 'artist': {
        const artists = new Set<string>()
        for (const t of this.tracks.values()) {
          t.artists.filter(matches).forEach((a) => artists.add(a))
        }
        results = Array.from(artists, (name) => ({
          type: 'artist',
          id: `artist:${name}`,
          ref: `artist:${name}`,
          name,
        }))
        break
      }

      case 'playlist':
        results = Array.from(this.playlists.values())
          .filter((p) => matches(p.name))
          .map((p) => ({
            type: 'playlist',
            id: p.id,
            ref: p.id,
            name: p.name,
            owner: { id: p.owner, displayName: p.owner },
            trackCount: p.trackIds.length,
          }))
        break

      default:
        results = []
    }

    return {
      items: results.slice(offset, offset + limit),
      next: offset + limit < results.length ? { offset: offset + limit } : undefined,
      total: results.length,
    }
  }

  async listPlaylists(page: PageRequest, filter?: PlaylistFilter): Promise<Page<PlaylistSummary>> {
    const limit = page.limit ?? 50
    const offset = page.offset ?? 0
    const results = Array.from(this.playlists.values())

    const items = results
      .slice(offset, offset + limit)
      .map((p) => this.playlistToSummary(p))
      .filter((p) => (filter === 'owned' ? p.owned : filter === 'followed' ? !p.owned : true))

    return {
      items,
      next: offset + limit < results.length ? { offset: offset + limit } : undefined,
    }
  }

  async getPlaylist(ref: string): Promise<PlaylistSummary> {
    const playlist = this.playlists.get(ref)
    if (!playlist) {
      throw new NotFoundError(`Playlist ${ref} not found`, 'playlist')
    }

    return this.playlistToSummary(playlist)
  }

  async getPlaylistTracks(ref: string, page: PageRequest): Promise<Page<CanonicalTrack>> {
    const playlist = this.playlists.get(ref)
    if (!playlist) {
      throw new NotFoundError(`Playlist ${ref} not found`, 'playlist')
    }

    if (!this.isItemsReadable(playlist)) {
      throw new AccessRestrictedError(
        'Items of this playlist are not readable by the logged-in user',
        'not-owned'
      )
    }

    const limit = page.limit ?? 50
    const offset = page.offset ?? 0
    const allTracks = playlist.trackIds
      .map((id) => this.tracks.get(id))
      .filter((t): t is FakeTrack => t !== undefined)

    return {
      items: allTracks
        .slice(offset, offset + limit)
        .map((t) => this.trackToCanonical(t)),
      next: offset + limit < allTracks.length ? { offset: offset + limit } : undefined,
    }
  }

  async getLikedTracks(_page: PageRequest): Promise<Page<CanonicalTrack>> {
    // Fake provider doesn't track likes, return empty
    return { items: [] }
  }

  async createPlaylist(input: {
    name: string
    description?: string
    public: boolean
    collaborative?: boolean
  }): Promise<PlaylistSummary> {
    const id = String(this.nextPlaylistId++)
    const playlist: FakePlaylist = {
      id,
      name: input.name,
      description: input.description,
      owner: this.userId,
      public: input.public,
      collaborative: input.collaborative ?? false,
      trackIds: [],
    }

    this.playlists.set(id, playlist)
    return this.playlistToSummary(playlist)
  }

  async removePlaylist(ref: string): Promise<{ action: 'deleted' | 'unfollowed' }> {
    const playlist = this.playlists.get(ref)
    if (!playlist) {
      throw new NotFoundError(`Playlist ${ref} not found`, 'playlist')
    }

    if (playlist.owner !== this.userId) {
      throw new AccessRestrictedError(
        'Cannot remove playlist not owned by user',
        'not-owned'
      )
    }

    this.playlists.delete(ref)
    return { action: 'deleted' }
  }

  async resolveTrack(
    track: CanonicalTrack,
    opts: { maxCandidates: number }
  ): Promise<MatchCandidate[]> {
    const candidates: MatchCandidate[] = []

    // Try known ref first
    for (const [provider, ref] of Object.entries(track.refs)) {
      if (provider === 'fake' && this.tracks.has(ref)) {
        candidates.push({
          ref,
          track: this.trackToCanonical(this.tracks.get(ref)!),
          confidence: 1.0,
          strategy: 'known-ref',
        })
      }
    }

    if (candidates.length >= opts.maxCandidates) {
      return candidates.slice(0, opts.maxCandidates)
    }

    // Try ISRC if available
    if (track.isrc && this.capabilities.isrcSearchMode === 'filter') {
      for (const fakeTrack of this.tracks.values()) {
        if (fakeTrack.isrc === track.isrc) {
          candidates.push({
            ref: fakeTrack.id,
            track: this.trackToCanonical(fakeTrack),
            confidence: 1.0,
            strategy: 'isrc',
          })
          if (candidates.length >= opts.maxCandidates) {
            return candidates.slice(0, opts.maxCandidates)
          }
        }
      }
    }

    // Try title + artists match
    for (const fakeTrack of this.tracks.values()) {
      if (
        fakeTrack.title.toLowerCase() === track.title.toLowerCase() &&
        fakeTrack.artists.some((a) =>
          track.artists?.some((ca) => a.toLowerCase() === ca.toLowerCase())
        )
      ) {
        candidates.push({
          ref: fakeTrack.id,
          track: this.trackToCanonical(fakeTrack),
          confidence: 0.95,
          strategy: 'metadata',
        })
        if (candidates.length >= opts.maxCandidates) {
          return candidates.slice(0, opts.maxCandidates)
        }
      }
    }

    return candidates
  }

  async populatePlaylist(
    ref: string,
    trackRefs: string[],
    opts: { skipExisting: boolean }
  ): Promise<{ added: string[]; failed: Array<{ ref: string; error: string }> }> {
    const playlist = this.playlists.get(ref)
    if (!playlist) {
      throw new NotFoundError(`Playlist ${ref} not found`, 'playlist')
    }

    const added: string[] = []
    const failed: Array<{ ref: string; error: string }> = []

    for (const trackRef of trackRefs) {
      if (!this.tracks.has(trackRef)) {
        failed.push({ ref: trackRef, error: 'Track not found' })
        continue
      }

      if (opts.skipExisting && playlist.trackIds.includes(trackRef)) {
        continue
      }

      if (this.quotaBucket <= 0) {
        throw new QuotaExhaustedError(
          'Daily quota exceeded',
          'daily',
          new Date(Date.now() + 24 * 60 * 60 * 1000)
        )
      }

      playlist.trackIds.push(trackRef)
      this.quotaBucket--
      added.push(trackRef)
    }

    return { added, failed }
  }

  private trackToCanonical(track: FakeTrack): CanonicalTrack {
    return {
      title: track.title,
      artists: track.artists,
      album: track.album,
      durationMs: track.duration,
      isrc: track.isrc ?? null,
      refs: {
        fake: track.id,
      },
      addedAt: new Date().toISOString(),
    }
  }

  /**
   * Mirrors ProviderCapabilities.playlistItemsAccess. For
   * 'owned-or-collaborator' the fake uses the collaborative flag as its
   * read-time signal; real adapters probe the provider (ADR-0003 Amendment 1).
   */
  private isItemsReadable(playlist: FakePlaylist): boolean {
    const owned = playlist.owner === this.userId
    switch (this.capabilities.playlistItemsAccess) {
      case 'all':
        return true
      case 'owned-only':
        return owned
      case 'owned-or-collaborator':
        return owned || playlist.collaborative
    }
  }

  private playlistToSummary(playlist: FakePlaylist): PlaylistSummary {
    return {
      ref: playlist.id,
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      owner: { id: playlist.owner, displayName: playlist.owner },
      owned: playlist.owner === this.userId,
      itemsReadable: this.isItemsReadable(playlist),
      trackCount: playlist.trackIds.length,
      public: playlist.public,
      collaborative: playlist.collaborative,
    }
  }

  // Helper methods for testing
  addTrack(track: FakeTrack): void {
    this.tracks.set(track.id, track)
  }

  getTrack(id: string): FakeTrack | undefined {
    return this.tracks.get(id)
  }

  setQuotaBucket(amount: number): void {
    this.quotaBucket = amount
  }

  getQuotaBucket(): number {
    return this.quotaBucket
  }
}

export default FakeProvider
