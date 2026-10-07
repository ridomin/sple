import { HttpClient } from '../../core/http/client.js'
import { PlaylistSummary, CanonicalTrack } from '../../core/provider/provider.js'
import { NotFoundError, isFatalProviderError } from '../../core/provider/errors.js'
import { YouTubeConflictError } from './errors.js'
import { isTopicChannel, videoTrackMetadata } from './track-metadata.js'
import * as YouTubeTypes from './types.js'
import { parseYouTubePlaylistId, parseYouTubeTrackRef } from './playlist-ref.js'

export class YouTubeMusicHttpClient {
  private readonly baseUrl = 'https://www.googleapis.com/youtube/v3'

  /** Waits before each retry of a 409 on playlistItems.insert; its length is the retry count. */
  private conflictRetryDelaysMs: number[]

  constructor(
    private httpClient: HttpClient,
    options: { conflictRetryDelaysMs?: number[] } = {}
  ) {
    this.conflictRetryDelaysMs = options.conflictRetryDelaysMs ?? [1000, 2000]
  }

  async listPlaylists(page?: { limit?: number; cursor?: string }): Promise<{ items: PlaylistSummary[]; nextPageToken?: string; totalResults?: number }> {
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

    return {
      // mine=true returns only the user's own playlists.
      items: body.items.map(p => this.youtubePlaylistToCanonical(p, true)),
      nextPageToken: body.nextPageToken,
      totalResults: body.pageInfo.totalResults
    }
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

    if (!body.items.length) throw new NotFoundError(`Playlist not found: ${ref}`, 'playlist')
    const playlist = body.items[0]
    return this.youtubePlaylistToCanonical(playlist, playlist.snippet.channelId === (await this.getMyChannelId()))
  }

  async getPlaylistTracks(ref: string, page?: { limit?: number; cursor?: string }): Promise<{ items: CanonicalTrack[]; nextPageToken?: string; totalResults?: number }> {
    const playlistId = this.extractPlaylistId(ref)
    if (!playlistId) throw new Error(`Invalid playlist ref: ${ref}`)
    return this.playlistItemsPage(playlistId, page)
  }

  /**
   * Liked Songs: YouTube Music's "Liked Music" playlist `LM`. Not a documented
   * ID, but the Data API serves it (spike S5); `addedAt` is the like time.
   */
  async getLikedTracks(page?: { limit?: number; cursor?: string }): Promise<{ items: CanonicalTrack[]; nextPageToken?: string; totalResults?: number }> {
    return this.playlistItemsPage('LM', page)
  }

  private async playlistItemsPage(
    playlistId: string,
    page?: { limit?: number; cursor?: string }
  ): Promise<{ items: CanonicalTrack[]; nextPageToken?: string; totalResults?: number }> {
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

    if (videoIds.length === 0) return { items: [], nextPageToken: body.nextPageToken, totalResults: body.pageInfo.totalResults }

    const videos = await this.getVideos(videoIds)
    const videoMap = new Map(videos.map(v => [v.id, v]))

    const items = body.items
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

    return {
      items,
      nextPageToken: body.nextPageToken,
      totalResults: body.pageInfo.totalResults
    }
  }

  /**
   * `musicOnly` (matching, ADR-0002 R3) restricts the search to the Music
   * category and ranks "Artist - Topic" uploads first, keeping API order otherwise.
   */
  async searchTracks(
    q: { text: string },
    page?: { limit?: number; cursor?: string },
    options: { musicOnly?: boolean } = {}
  ): Promise<{ items: CanonicalTrack[]; nextPageToken?: string; totalResults?: number }> {
    const maxResults = page?.limit ?? 50
    const url = new URL(this.baseUrl + '/search')
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('type', 'video')
    if (options.musicOnly) url.searchParams.set('videoCategoryId', '10')
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

    if (videoIds.length === 0) return { items: [], nextPageToken: body.nextPageToken, totalResults: body.pageInfo.totalResults }

    let videos = await this.getVideos(videoIds)
    if (options.musicOnly) {
      const topic = videos.filter(v => isTopicChannel(v.snippet.channelTitle))
      videos = [...topic, ...videos.filter(v => !topic.includes(v))]
    }
    const items = videos
      .map(v => this.youtubeVideoToCanonical(v))
      .filter((t): t is CanonicalTrack => t !== null)

    return {
      items,
      nextPageToken: body.nextPageToken,
      totalResults: body.pageInfo.totalResults
    }
  }

  /** `search.list` for playlists or channels (`--type playlist` / `artist`); no extra `videos.list` call. */
  async searchResources(
    type: 'playlist' | 'channel',
    text: string,
    page?: { limit?: number; cursor?: string }
  ): Promise<{ items: YouTubeTypes.YouTubeSearchResult[]; nextPageToken?: string; totalResults?: number }> {
    const url = new URL(this.baseUrl + '/search')
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('type', type)
    url.searchParams.set('q', text)
    url.searchParams.set('maxResults', String(page?.limit ?? 50))
    if (page?.cursor) url.searchParams.set('pageToken', page.cursor)

    const body = await this.httpClient.requestJson(
      { method: 'GET', url: url.toString() },
      (data: unknown) => data as YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubeSearchResult>
    )
    return { items: body.items, nextPageToken: body.nextPageToken, totalResults: body.pageInfo.totalResults }
  }

  private myChannelId?: Promise<string | undefined>

  /** The user's channel ID (`channels.list?mine=true`, 1 unit), looked up once per run. */
  private getMyChannelId(): Promise<string | undefined> {
    this.myChannelId ??= (async () => {
      const url = new URL(this.baseUrl + '/channels')
      url.searchParams.set('part', 'id')
      url.searchParams.set('mine', 'true')
      const body = await this.httpClient.requestJson(
        { method: 'GET', url: url.toString() },
        (data: unknown) => data as YouTubeTypes.YouTubeListResponse<{ id: string }>
      )
      return body.items[0]?.id
    })()
    return this.myChannelId
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

    return this.youtubePlaylistToCanonical(body, true)
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

        await this.insertPlaylistItem(playlistId, videoId)
        added.push(trackRef)
      } catch (err) {
        // Auth, quota and rate limits would fail every remaining track too.
        if (isFatalProviderError(err)) throw err
        failed.push({ ref: trackRef, error: (err as Error).message })
      }
    }

    return { added, failed }
  }

  /** playlistItems.insert, retrying the transient 409 seen right after a playlist is created. */
  private async insertPlaylistItem(playlistId: string, videoId: string): Promise<void> {
    const url = new URL(this.baseUrl + '/playlistItems')
    url.searchParams.set('part', 'snippet')
    const request = {
      method: 'POST',
      url: url.toString(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snippet: {
          playlistId,
          resourceId: { kind: 'youtube#video', videoId }
        }
      })
    }

    for (let attempt = 0; ; attempt++) {
      try {
        await this.httpClient.request(request)
        return
      } catch (err) {
        const delay = this.conflictRetryDelaysMs[attempt]
        if (!(err instanceof YouTubeConflictError) || delay === undefined) throw err
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
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

  private youtubePlaylistToCanonical(playlist: YouTubeTypes.YouTubePlaylist, owned: boolean): PlaylistSummary {
    return {
      ref: playlist.id,
      id: playlist.id,
      name: playlist.snippet.title,
      description: playlist.snippet.description || undefined,
      owner: { id: playlist.snippet.channelId, displayName: playlist.snippet.channelTitle },
      owned,
      itemsReadable: true,
      trackCount: playlist.contentDetails?.itemCount,
      public: playlist.status?.privacyStatus === 'public',
      url: `https://www.youtube.com/playlist?list=${playlist.id}`
    }
  }

  private youtubeVideoToCanonical(video: YouTubeTypes.YouTubeVideo): CanonicalTrack | null {
    if (!video.id) return null
    const { title, artists } = videoTrackMetadata(video.snippet.title, video.snippet.channelTitle)
    return {
      title,
      artists,
      album: undefined,
      durationMs: this.parseDuration(video.contentDetails?.duration),
      refs: {
        'youtube-music': video.id
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

  private extractPlaylistId(ref: string): string | null {
    return parseYouTubePlaylistId(ref)
  }

  private extractVideoId(ref: string): string | null {
    return parseYouTubeTrackRef(ref)
  }
}
