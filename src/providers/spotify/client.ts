import { HttpClient } from '../../core/http/client.js'
import { PlaylistSummary, CanonicalTrack, MatchCandidate } from '../../core/provider/provider.js'
import * as SpotifyTypes from './types.js'

export class SpotifyHttpClient {
  private readonly baseUrl = 'https://api.spotify.com/v1'

  constructor(private httpClient: HttpClient) {}

  async getPlaylist(ref: string): Promise<PlaylistSummary> {
    const playlistId = this.extractPlaylistId(ref)
    if (!playlistId) throw new Error(`Invalid playlist ref: ${ref}`)

    const url = new URL(this.baseUrl + `/playlists/${playlistId}`)
    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as SpotifyTypes.SpotifyPlaylist
    )

    return this.spotifyPlaylistToCanonical(body)
  }

  async getPlaylistTracks(ref: string, page?: { limit?: number; offset?: number }): Promise<CanonicalTrack[]> {
    const playlistId = this.extractPlaylistId(ref)
    if (!playlistId) throw new Error(`Invalid playlist ref: ${ref}`)

    const limit = page?.limit ?? 50
    const offset = page?.offset ?? 0

    const url = new URL(this.baseUrl + `/playlists/${playlistId}/tracks`)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as { items: SpotifyTypes.SpotifyPlaylistTrack[]; total: number; next: string | null }
    )

    return body.items
      .filter(item => item.track !== null)
      .map(item => this.spotifyTrackToCanonical(item.track!, item.added_at))
  }

  async searchTracks(q: { text: string }, page?: { limit?: number; offset?: number }): Promise<CanonicalTrack[]> {
    const limit = page?.limit ?? 50
    const offset = page?.offset ?? 0

    const url = new URL(this.baseUrl + '/search')
    url.searchParams.set('q', q.text)
    url.searchParams.set('type', 'track')
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as SpotifyTypes.SpotifySearchResponse
    )

    return body.tracks.items.map(t => this.spotifyTrackToCanonical(t))
  }

  async resolveTrack(track: CanonicalTrack, opts: { maxCandidates: number }): Promise<MatchCandidate[]> {
    const query = `track:${track.title} artist:${track.artists.join(' ')}${track.album ? ` album:${track.album}` : ''}`

    const url = new URL(this.baseUrl + '/search')
    url.searchParams.set('q', query)
    url.searchParams.set('type', 'track')
    url.searchParams.set('limit', String(opts.maxCandidates))

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as SpotifyTypes.SpotifySearchResponse
    )

    return body.tracks.items
      .map(t => {
        const canonical = this.spotifyTrackToCanonical(t)
        return {
          ref: t.uri,
          track: canonical,
          confidence: this.calculateConfidence(track, t),
          strategy: 'metadata' as const
        }
      })
      .filter(c => c.confidence > 0)
  }

  async createPlaylist(input: {
    name: string
    description?: string
    public: boolean
    collaborative?: boolean
  }): Promise<PlaylistSummary> {
    const user = await this.getCurrentUser()
    const url = new URL(this.baseUrl + `/users/${user.id}/playlists`)

    const body = await this.httpClient.requestJson(
      {
        method: 'POST',
        url: url.toString(),
        body: JSON.stringify({
          name: input.name,
          description: input.description ?? '',
          public: input.public,
          collaborative: input.collaborative ?? false
        })
      },
      (data: unknown) => data as SpotifyTypes.SpotifyPlaylist
    )

    return this.spotifyPlaylistToCanonical(body)
  }

  async removePlaylist(ref: string): Promise<{ action: 'deleted' | 'unfollowed' }> {
    const playlistId = this.extractPlaylistId(ref)
    if (!playlistId) throw new Error(`Invalid playlist ref: ${ref}`)

    const url = new URL(this.baseUrl + `/playlists/${playlistId}/followers`)
    await this.httpClient.request({ method: 'DELETE', url: url.toString() })
    return { action: 'deleted' }
  }

  async populatePlaylist(
    ref: string,
    trackRefs: string[],
    _opts: { skipExisting: boolean }
  ): Promise<{ added: string[]; failed: Array<{ ref: string; error: string }> }> {
    const playlistId = this.extractPlaylistId(ref)
    if (!playlistId) throw new Error(`Invalid playlist ref: ${ref}`)

    const added: string[] = []
    const failed: Array<{ ref: string; error: string }> = []

    // Spotify can accept up to 100 URIs per request
    for (let i = 0; i < trackRefs.length; i += 100) {
      try {
        const batch = trackRefs.slice(i, i + 100)
        const url = new URL(this.baseUrl + `/playlists/${playlistId}/tracks`)

        await this.httpClient.request({
          method: 'POST',
          url: url.toString(),
          body: JSON.stringify({ uris: batch })
        })

        added.push(...batch)
      } catch (err) {
        const batch = trackRefs.slice(i, i + 100)
        batch.forEach(ref => {
          failed.push({ ref, error: (err as Error).message })
        })
      }
    }

    return { added, failed }
  }

  async getLikedTracks(page?: { limit?: number; offset?: number }): Promise<CanonicalTrack[]> {
    const limit = page?.limit ?? 50
    const offset = page?.offset ?? 0

    const url = new URL(this.baseUrl + '/me/tracks')
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as { items: SpotifyTypes.SpotifyPlaylistTrack[]; total: number; next: string | null }
    )

    return body.items
      .filter(item => item.track !== null)
      .map(item => this.spotifyTrackToCanonical(item.track!, item.added_at))
  }

  private async getCurrentUser(): Promise<{ id: string; display_name: string }> {
    const url = new URL(this.baseUrl + '/me')
    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as SpotifyTypes.SpotifyUser
    )
    return {
      id: body.id,
      display_name: body.display_name ?? 'Unknown'
    }
  }

  private spotifyPlaylistToCanonical(playlist: SpotifyTypes.SpotifyPlaylist): PlaylistSummary {
    return {
      ref: playlist.uri,
      id: playlist.id,
      name: playlist.name,
      description: playlist.description || undefined,
      owner: { id: playlist.owner.id, displayName: playlist.owner.display_name },
      owned: true,
      itemsReadable: true,
      trackCount: playlist.tracks.total,
      public: playlist.public,
      url: playlist.external_urls.spotify
    }
  }

  private spotifyTrackToCanonical(track: SpotifyTypes.SpotifyTrack, addedAt?: string): CanonicalTrack {
    return {
      title: track.name,
      artists: track.artists.map(a => a.name),
      album: track.album.name,
      durationMs: track.duration_ms,
      isrc: track.external_ids?.isrc || null,
      refs: {
        spotify: track.uri
      },
      addedAt: addedAt ? new Date(addedAt).toISOString() : undefined
    }
  }

  private calculateConfidence(track: CanonicalTrack, spotifyTrack: SpotifyTypes.SpotifyTrack): number {
    const titleMatch = track.title.toLowerCase().includes(spotifyTrack.name.toLowerCase()) ||
      spotifyTrack.name.toLowerCase().includes(track.title.toLowerCase()) ? 0.5 : 0
    const artistMatch = track.artists.some(a =>
      spotifyTrack.artists.some(sa => sa.name.toLowerCase().includes(a.toLowerCase()) ||
        a.toLowerCase().includes(sa.name.toLowerCase()))
    ) ? 0.5 : 0
    return titleMatch + artistMatch
  }

  private extractPlaylistId(ref: string): string | null {
    // Handle spotify:playlist:ID or https://open.spotify.com/playlist/ID or just ID
    if (ref.startsWith('spotify:playlist:')) {
      return ref.replace('spotify:playlist:', '')
    }
    try {
      const url = new URL(ref)
      const match = url.pathname.match(/\/playlist\/([a-zA-Z0-9]+)/)
      return match ? match[1] : null
    } catch {
      return ref // Assume it's a raw ID
    }
  }
}
