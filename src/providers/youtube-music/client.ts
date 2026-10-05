import { HttpClient } from '../../core/http/client.js'
import { PlaylistSummary, CanonicalTrack, MatchCandidate } from '../../core/provider/provider.js'
import * as YouTubeTypes from './types.js'

export class YouTubeMusicHttpClient {
  private readonly baseUrl = 'https://www.googleapis.com/youtube/v3'

  constructor(private httpClient: HttpClient) {}

  async listPlaylists(page?: { limit?: number; cursor?: string }): Promise<PlaylistSummary[]> {
    const maxResults = page?.limit ?? 50
    const url = new URL(this.baseUrl + '/playlists')
    url.searchParams.set('part', 'snippet,contentDetails,status')
    url.searchParams.set('mine', 'true')
    url.searchParams.set('maxResults', String(maxResults))
    if (page?.cursor) {
      url.searchParams.set('pageToken', page.cursor)
    }

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylist>
    )

    return body.items.map(p => this.youtubePlaylistToCanonical(p))
  }

  async getPlaylist(ref: string): Promise<PlaylistSummary> {
    const playlistId = this.extractPlaylistId(ref)
    if (!playlistId) throw new Error(`Invalid playlist ref: ${ref}`)

    const url = new URL(this.baseUrl + '/playlists')
    url.searchParams.set('part', 'snippet,contentDetails,status')
    url.searchParams.set('id', playlistId)

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylist>
    )

    if (!body.items.length) throw new Error(`Playlist not found: ${ref}`)
    return this.youtubePlaylistToCanonical(body.items[0])
  }

  async getPlaylistTracks(ref: string, page?: { limit?: number; cursor?: string }): Promise<CanonicalTrack[]> {
    const playlistId = this.extractPlaylistId(ref)
    if (!playlistId) throw new Error(`Invalid playlist ref: ${ref}`)

    const maxResults = page?.limit ?? 50
    const url = new URL(this.baseUrl + '/playlistItems')
    url.searchParams.set('part', 'snippet,contentDetails')
    url.searchParams.set('playlistId', playlistId)
    url.searchParams.set('maxResults', String(maxResults))
    if (page?.cursor) {
      url.searchParams.set('pageToken', page.cursor)
    }

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylistItem>
    )

    const videoIds = body.items
      .map(item => item.contentDetails?.videoId || item.snippet.resourceId.videoId)
      .filter(Boolean)

    if (videoIds.length === 0) return []

    const videos = await this.getVideos(videoIds)
    const videoMap = new Map(videos.map(v => [v.id, v]))

    return body.items
      .map(item => {
        const videoId = item.contentDetails?.videoId || item.snippet.resourceId.videoId
        const video = videoMap.get(videoId)
        if (!video) return null
        const track = this.youtubeVideoToCanonical(video)
        if (track && item.snippet.publishedAt) {
          track.addedAt = item.snippet.publishedAt
        }
        return track
      })
      .filter((t): t is CanonicalTrack => t !== null)
  }

  async searchTracks(q: { text: string }, page?: { limit?: number; cursor?: string }): Promise<CanonicalTrack[]> {
    const maxResults = page?.limit ?? 50
    const url = new URL(this.baseUrl + '/search')
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('type', 'video')
    url.searchParams.set('q', q.text)
    url.searchParams.set('maxResults', String(maxResults))
    if (page?.cursor) {
      url.searchParams.set('pageToken', page.cursor)
    }

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubeSearchResult>
    )

    const videoIds = body.items.filter(item => item.id.videoId).map(item => item.id.videoId!)

    if (videoIds.length === 0) return []

    const videos = await this.getVideos(videoIds)
    return videos
      .map(v => this.youtubeVideoToCanonical(v))
      .filter((t): t is CanonicalTrack => t !== null)
  }

  async resolveTrack(track: CanonicalTrack, opts: { maxCandidates: number }): Promise<MatchCandidate[]> {
    const query = `${track.title} ${track.artists.join(' ')}`
    const url = new URL(this.baseUrl + '/search')
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('type', 'video')
    url.searchParams.set('q', query)
    url.searchParams.set('maxResults', String(opts.maxCandidates))

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubeSearchResult>
    )

    const videoIds = body.items.filter(item => item.id.videoId).map(item => item.id.videoId!)

    if (videoIds.length === 0) return []

    const videos = await this.getVideos(videoIds)

    const candidates: MatchCandidate[] = []
    for (const v of videos) {
      const canonicalTrack = this.youtubeVideoToCanonical(v)
      if (canonicalTrack) {
        candidates.push({
          ref: `https://www.youtube.com/watch?v=${v.id}`,
          track: canonicalTrack,
          confidence: this.calculateConfidence(track, v),
          strategy: 'metadata'
        })
      }
    }
    return candidates
  }

  async createPlaylist(input: {
    name: string
    description?: string
    public: boolean
    collaborative?: boolean
  }): Promise<PlaylistSummary> {
    const url = new URL(this.baseUrl + '/playlists')
    url.searchParams.set('part', 'snippet,status')

    const body = await this.httpClient.requestJson(
      {
        method: 'POST',
        url: url.toString(),
        body: JSON.stringify({
          snippet: { title: input.name, description: input.description ?? '' },
          status: { privacyStatus: input.public ? 'public' : 'private' }
        })
      },
      (data: unknown) => data as YouTubeTypes.YouTubePlaylist
    )

    return this.youtubePlaylistToCanonical(body)
  }

  async removePlaylist(ref: string): Promise<{ action: 'deleted' | 'unfollowed' }> {
    const playlistId = this.extractPlaylistId(ref)
    if (!playlistId) throw new Error(`Invalid playlist ref: ${ref}`)

    const url = new URL(this.baseUrl + '/playlists')
    url.searchParams.set('id', playlistId)

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

    for (const trackRef of trackRefs) {
      try {
        const videoId = this.extractVideoId(trackRef)
        if (!videoId) {
          failed.push({ ref: trackRef, error: 'Invalid video ID' })
          continue
        }

        const url = new URL(this.baseUrl + '/playlistItems')
        url.searchParams.set('part', 'snippet')

        await this.httpClient.request({
          method: 'POST',
          url: url.toString(),
          body: JSON.stringify({
            snippet: {
              playlistId,
              resourceId: { kind: 'youtube#video', videoId }
            }
          })
        })

        added.push(trackRef)
      } catch (err) {
        failed.push({ ref: trackRef, error: (err as Error).message })
      }
    }

    return { added, failed }
  }

  private async getVideos(videoIds: string[]): Promise<YouTubeTypes.YouTubeVideo[]> {
    if (!videoIds.length) return []

    const url = new URL(this.baseUrl + '/videos')
    url.searchParams.set('part', 'snippet,contentDetails')
    url.searchParams.set('id', videoIds.join(','))

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubeVideo>
    )

    return body.items
  }

  private youtubePlaylistToCanonical(playlist: YouTubeTypes.YouTubePlaylist): PlaylistSummary {
    return {
      ref: `https://www.youtube.com/playlist?list=${playlist.id}`,
      id: playlist.id,
      name: playlist.snippet.title,
      description: playlist.snippet.description || undefined,
      owner: { id: playlist.id, displayName: playlist.snippet.channelTitle },
      owned: true,
      itemsReadable: true,
      trackCount: playlist.contentDetails?.itemCount,
      public: playlist.status?.privacyStatus === 'public',
      url: `https://www.youtube.com/playlist?list=${playlist.id}`
    }
  }

  private youtubeVideoToCanonical(video: YouTubeTypes.YouTubeVideo): CanonicalTrack | null {
    if (!video.id) return null
    return {
      title: video.snippet.title,
      artists: [video.snippet.channelTitle],
      album: undefined,
      durationMs: this.parseDuration(video.contentDetails?.duration),
      refs: {
        'youtube-music': `https://www.youtube.com/watch?v=${video.id}`
      },
      addedAt: video.snippet.publishedAt
    }
  }

  private parseDuration(iso8601?: string): number {
    if (!iso8601) return 0
    const match = iso8601.match(/PT(\d+H)?(\d+M)?(\d+S)?/)
    if (!match) return 0
    const hours = parseInt(match[1]) || 0
    const minutes = parseInt(match[2]) || 0
    const seconds = parseInt(match[3]) || 0
    return (hours * 3600 + minutes * 60 + seconds) * 1000
  }

  private calculateConfidence(track: CanonicalTrack, video: YouTubeTypes.YouTubeVideo): number {
    const titleMatch = track.title.toLowerCase().includes(video.snippet.title.toLowerCase()) ||
      video.snippet.title.toLowerCase().includes(track.title.toLowerCase()) ? 0.5 : 0
    const artistMatch = track.artists.some(a =>
      video.snippet.channelTitle.toLowerCase().includes(a.toLowerCase()) ||
      a.toLowerCase().includes(video.snippet.channelTitle.toLowerCase())
    ) ? 0.5 : 0
    return titleMatch + artistMatch
  }

  private extractPlaylistId(ref: string): string | null {
    try {
      const url = new URL(ref)
      return url.searchParams.get('list') || null
    } catch {
      return null
    }
  }

  private extractVideoId(ref: string): string | null {
    try {
      const url = new URL(ref)
      return url.searchParams.get('v') || null
    } catch {
      return null
    }
  }
}
