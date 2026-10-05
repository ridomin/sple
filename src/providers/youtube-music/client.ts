import { HttpClient } from '../../core/http/client.js';
import {
  AuthRequiredError,
  AccessRestrictedError,
  NotFoundError,
  RateLimitError,
  QuotaExhaustedError,
  UsageError
} from '../../core/provider/errors.js';
import { PlaylistSummary, CanonicalTrack, MatchCandidate } from '../../core/provider/provider.js';
import * as YouTubeTypes from './types.js';

export class YouTubeMusicHttpClient {
  private readonly baseUrl = 'https://www.googleapis.com/youtube/v3';

  constructor(private httpClient: HttpClient, private apiKey: string = '') {}

  async listPlaylists(options?: { limit?: number; pageToken?: string }): Promise<{
    playlists: PlaylistSummary[];
    total: number;
    nextPageToken?: string;
  }> {
    const maxResults = options?.limit ?? 50;
    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylist>>(
      'GET',
      '/playlists',
      { part: 'snippet,contentDetails,status', mine: true, maxResults, pageToken: options?.pageToken }
    );

    return {
      playlists: response.items.map(p => this.youtubePlaylistToCanonical(p)),
      total: response.pageInfo.totalResults,
      nextPageToken: response.nextPageToken
    };
  }

  async getPlaylist(playlistId: string): Promise<PlaylistSummary> {
    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylist>>(
      'GET',
      '/playlists',
      { part: 'snippet,contentDetails,status', id: playlistId }
    );

    if (!response.items.length) {
      throw new NotFoundError(`Playlist ${playlistId} not found`);
    }
    return this.youtubePlaylistToCanonical(response.items[0]);
  }

  async getPlaylistTracks(playlistId: string, options?: { limit?: number; pageToken?: string }): Promise<{
    tracks: CanonicalTrack[];
    total: number;
    nextPageToken?: string;
  }> {
    const maxResults = options?.limit ?? 50;
    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylistItem>>(
      'GET',
      '/playlistItems',
      { part: 'snippet,contentDetails', playlistId, maxResults, pageToken: options?.pageToken }
    );

    const videoIds = response.items
      .map(item => item.contentDetails?.videoId || item.snippet.resourceId.videoId)
      .filter(Boolean);

    const videos = videoIds.length > 0 ? await this.getVideos(videoIds) : [];
    const videoMap = new Map(videos.map(v => [v.id, v]));

    return {
      tracks: response.items
        .map((item, idx) => {
          const videoId = item.contentDetails?.videoId || item.snippet.resourceId.videoId;
          const video = videoMap.get(videoId);
          return video ? this.youtubeVideoToCanonical(video, item.snippet.publishedAt) : null;
        })
        .filter((t): t is CanonicalTrack => t !== null),
      total: response.pageInfo.totalResults,
      nextPageToken: response.nextPageToken
    };
  }

  async createPlaylist(name: string, description?: string): Promise<PlaylistSummary> {
    const response = await this.request<YouTubeTypes.YouTubePlaylist>(
      'POST',
      '/playlists',
      { part: 'snippet,status' },
      {
        snippet: { title: name, description: description ?? '' },
        status: { privacyStatus: 'private' }
      }
    );
    return this.youtubePlaylistToCanonical(response);
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await this.request('DELETE', '/playlists', { id: playlistId });
  }

  async addTracksToPlaylist(playlistId: string, videoIds: string[]): Promise<void> {
    for (const videoId of videoIds) {
      await this.request(
        'POST',
        '/playlistItems',
        { part: 'snippet' },
        {
          snippet: {
            playlistId,
            resourceId: { kind: 'youtube#video', videoId }
          }
        }
      );
    }
  }

  async removeTracksFromPlaylist(playlistId: string, videoIds: string[]): Promise<void> {
    // Get all items in playlist
    const items = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylistItem>>(
      'GET',
      '/playlistItems',
      { part: 'snippet,contentDetails', playlistId, maxResults: 50 }
    );

    for (const item of items.items) {
      const videoId = item.contentDetails?.videoId || item.snippet.resourceId.videoId;
      if (videoIds.includes(videoId)) {
        await this.request('DELETE', '/playlistItems', { id: item.id });
      }
    }
  }

  async searchTracks(query: string, options?: { limit?: number; pageToken?: string }): Promise<{
    tracks: CanonicalTrack[];
    total: number;
    nextPageToken?: string;
  }> {
    const maxResults = options?.limit ?? 50;
    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubeSearchResult>>(
      'GET',
      '/search',
      { part: 'snippet', type: 'video', q: query, maxResults, pageToken: options?.pageToken }
    );

    const videoIds = response.items
      .filter(item => item.id.videoId)
      .map(item => item.id.videoId!);

    const videos = videoIds.length > 0 ? await this.getVideos(videoIds) : [];

    return {
      tracks: videos.map(v => this.youtubeVideoToCanonical(v)).filter((t): t is CanonicalTrack => t !== null),
      total: response.pageInfo.totalResults,
      nextPageToken: response.nextPageToken
    };
  }

  async resolveTrack(title: string, artists: string[], album?: string): Promise<MatchCandidate[]> {
    const query = `${title} ${artists.join(' ')}`;
    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubeSearchResult>>(
      'GET',
      '/search',
      { part: 'snippet', type: 'video', q: query, maxResults: 10 }
    );

    const videoIds = response.items
      .filter(item => item.id.videoId)
      .map(item => item.id.videoId!);

    const videos = videoIds.length > 0 ? await this.getVideos(videoIds) : [];

    return videos
      .map(v => ({
        trackRef: v.id,
        confidence: this.calculateConfidence(title, artists, v),
        metadata: {
          providerTrackId: v.id,
          title: v.snippet.title,
          artists: [v.snippet.channelTitle],
          duration: this.parseDuration(v.contentDetails?.duration)
        }
      }))
      .filter(c => c.confidence > 0);
  }

  private async getVideos(videoIds: string[]): Promise<YouTubeTypes.YouTubeVideo[]> {
    if (!videoIds.length) return [];
    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubeVideo>>(
      'GET',
      '/videos',
      { part: 'snippet,contentDetails', id: videoIds.join(',') }
    );
    return response.items;
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, any>,
    body?: Record<string, any>
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      Object.entries(query).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v));
        }
      });
    }
    if (this.apiKey) {
      url.searchParams.set('key', this.apiKey);
    }

    const response = await this.httpClient.request(method, url.toString(), {
      body: body ? JSON.stringify(body) : undefined
    });

    if (response.status === 401) {
      throw new AuthRequiredError('YouTube token expired or invalid');
    }
    if (response.status === 403) {
      const error = (response.body as any)?.error?.errors?.[0]?.reason;
      if (error === 'quotaExceeded') {
        throw new QuotaExhaustedError('YouTube quota exceeded');
      }
      throw new AccessRestrictedError('Access denied by YouTube');
    }
    if (response.status === 404) {
      throw new NotFoundError('Resource not found on YouTube');
    }
    if (response.status >= 400) {
      throw new UsageError(`YouTube API error: ${response.status}`);
    }

    return response.body as T;
  }

  private youtubePlaylistToCanonical(playlist: YouTubeTypes.YouTubePlaylist): PlaylistSummary {
    return {
      id: playlist.id,
      name: playlist.snippet.title,
      description: playlist.snippet.description,
      trackCount: playlist.contentDetails?.itemCount ?? 0,
      ownerName: playlist.snippet.channelTitle,
      ownerProviderId: '',
      isPublic: playlist.status?.privacyStatus === 'public',
      thumbnail: playlist.snippet.thumbnails?.high?.url,
      ref: `https://www.youtube.com/playlist?list=${playlist.id}`
    };
  }

  private youtubeVideoToCanonical(video: YouTubeTypes.YouTubeVideo, publishedAt?: string): CanonicalTrack | null {
    if (!video.id) return null;
    return {
      title: video.snippet.title,
      artists: [video.snippet.channelTitle],
      album: '',
      duration: this.parseDuration(video.contentDetails?.duration),
      ref: `https://www.youtube.com/watch?v=${video.id}`,
      providerTrackId: video.id,
      addedAt: publishedAt
    };
  }

  private parseDuration(iso8601?: string): number {
    if (!iso8601) return 0;
    const match = iso8601.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    if (!match) return 0;
    const hours = parseInt(match[1]) || 0;
    const minutes = parseInt(match[2]) || 0;
    const seconds = parseInt(match[3]) || 0;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  private calculateConfidence(title: string, artists: string[], video: YouTubeTypes.YouTubeVideo): number {
    const titleMatch = title.toLowerCase().includes(video.snippet.title.toLowerCase()) ? 0.5 : 0;
    const artistMatch = artists.some(a => video.snippet.channelTitle.toLowerCase().includes(a.toLowerCase())) ? 0.5 : 0;
    return titleMatch + artistMatch;
  }
}
