import type {
  Provider,
  PlaylistSummary,
  CanonicalTrack,
  MatchCandidate,
  Page,
  PageRequest,
  ProviderAuth,
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
          user: { id: token.userId, displayName: token.userId },
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

  async search(
    q: { text: string; type: 'track' | 'album' | 'artist' | 'playlist' },
    page: PageRequest
  ): Promise<Page<unknown>> {
    const limit = page.limit ?? this.capabilities.maxSearchPageSize
    const offset = page.offset ?? 0

    if (q.type === 'track') {
      const results = Array.from(this.tracks.values()).filter(
        (track) =>
          track.title.toLowerCase().includes(q.text.toLowerCase()) ||
          track.artists.some((a) =>
            a.toLowerCase().includes(q.text.toLowerCase())
          )
      )

      return {
        items: results.slice(offset, offset + limit).map((t) => this.trackToCanonical(t)),
        next: offset + limit < results.length ? { offset: offset + limit } : undefined,
      }
    }

    if (q.type === 'playlist') {
      const results = Array.from(this.playlists.values()).filter((p) =>
        p.name.toLowerCase().includes(q.text.toLowerCase())
      )

      return {
        items: results
          .slice(offset, offset + limit)
          .map((p) => this.playlistToSummary(p)),
        next: offset + limit < results.length ? { offset: offset + limit } : undefined,
      }
    }

    return { items: [] }
  }

  async listPlaylists(page: PageRequest): Promise<Page<PlaylistSummary>> {
    const limit = page.limit ?? 50
    const offset = page.offset ?? 0
    const results = Array.from(this.playlists.values())

    return {
      items: results
        .slice(offset, offset + limit)
        .map((p) => this.playlistToSummary(p)),
      next: offset + limit < results.length ? { offset: offset + limit } : undefined,
    }
  }

  async getPlaylist(ref: string): Promise<PlaylistSummary> {
    const playlist = this.playlists.get(ref)
    if (!playlist) {
      throw new NotFoundError(`Playlist ${ref} not found`, 'playlist')
    }

    if (
      this.capabilities.playlistItemsAccess === 'owned-only' &&
      playlist.owner !== this.userId
    ) {
      throw new AccessRestrictedError(
        'This playlist is not owned by the logged-in user',
        'not-owned'
      )
    }

    return this.playlistToSummary(playlist)
  }

  async getPlaylistTracks(ref: string, page: PageRequest): Promise<Page<CanonicalTrack>> {
    const playlist = this.playlists.get(ref)
    if (!playlist) {
      throw new NotFoundError(`Playlist ${ref} not found`, 'playlist')
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

  private playlistToSummary(playlist: FakePlaylist): PlaylistSummary {
    return {
      ref: playlist.id,
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      owner: { id: playlist.owner, displayName: playlist.owner },
      owned: playlist.owner === this.userId,
      itemsReadable: true,
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
