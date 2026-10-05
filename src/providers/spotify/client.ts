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
import * as SpotifyTypes from './types.js';

export class SpotifyHttpClient {
  private readonly baseUrl = 'https://api.spotify.com/v1';

  constructor(private httpClient: HttpClient) {}

  async listPlaylists(
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<{ playlists: PlaylistSummary[]; total: number; nextOffset?: number }> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const response = await this.request<SpotifyTypes.SpotifyPlaylistsResponse>(
      `GET`,
      `/users/${userId}/playlists`,
      { limit, offset }
    );

    return {
      playlists: response.items.map(p => this.spotifyPlaylistToCanonical(p)),
      total: response.total,
      nextOffset: response.next ? offset + limit : undefined
    };
  }

  async getPlaylist(playlistId: string): Promise<PlaylistSummary> {
    const response = await this.request<SpotifyTypes.SpotifyPlaylist>(
      `GET`,
      `/playlists/${playlistId}`
    );
    return this.spotifyPlaylistToCanonical(response);
  }

  async getPlaylistTracks(
    playlistId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<{ tracks: CanonicalTrack[]; total: number; nextOffset?: number }> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const response = await this.request<{
      items: SpotifyTypes.SpotifyPlaylistTrack[];
      total: number;
      next: string | null;
    }>(`GET`, `/playlists/${playlistId}/tracks`, { limit, offset });

    return {
      tracks: response.items
        .filter(item => item.track !== null)  // Skip unavailable tracks
        .map(item => this.spotifyTrackToCanonical(item.track!, item.added_at)),
      total: response.total,
      nextOffset: response.next ? offset + limit : undefined
    };
  }

  async createPlaylist(
    name: string,
    description?: string,
    isPublic?: boolean
  ): Promise<PlaylistSummary> {
    const user = await this.getCurrentUser();
    const response = await this.request<SpotifyTypes.SpotifyPlaylist>(
      `POST`,
      `/users/${user.id}/playlists`,
      undefined,
      { name, description: description ?? '', public: isPublic ?? true }
    );
    return this.spotifyPlaylistToCanonical(response);
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await this.request(`DELETE`, `/playlists/${playlistId}/followers`);
  }

  async addTracksToPlaylist(playlistId: string, trackUris: string[]): Promise<void> {
    for (let i = 0; i < trackUris.length; i += 100) {
      await this.request(
        `POST`,
        `/playlists/${playlistId}/tracks`,
        undefined,
        { uris: trackUris.slice(i, i + 100) }
      );
    }
  }

  async removeTracksFromPlaylist(playlistId: string, trackUris: string[]): Promise<void> {
    for (let i = 0; i < trackUris.length; i += 100) {
      await this.request(
        `DELETE`,
        `/playlists/${playlistId}/tracks`,
        undefined,
        { tracks: trackUris.slice(i, i + 100).map(uri => ({ uri })) }
      );
    }
  }

  async searchTracks(
    query: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<{ tracks: CanonicalTrack[]; total: number; nextOffset?: number }> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const response = await this.request<SpotifyTypes.SpotifySearchResponse>(
      `GET`,
      `/search`,
      { q: query, type: 'track', limit, offset }
    );

    return {
      tracks: response.tracks.items.map(t => this.spotifyTrackToCanonical(t)),
      total: response.tracks.total,
      nextOffset: response.tracks.next ? offset + limit : undefined
    };
  }

  async resolveTrack(
    title: string,
    artists: string[],
    album?: string
  ): Promise<MatchCandidate[]> {
    const query = `track:${title} artist:${artists.join(' ')}${album ? ` album:${album}` : ''}`;
    const response = await this.request<SpotifyTypes.SpotifySearchResponse>(
      `GET`,
      `/search`,
      { q: query, type: 'track', limit: 10 }
    );

    return response.tracks.items.map(t => ({
      trackRef: `spotify:track:${t.id}`,
      confidence: this.calculateConfidence(title, artists, t),
      metadata: {
        providerTrackId: t.id,
        title: t.name,
        artists: t.artists.map(a => a.name),
        album: t.album.name,
        duration: t.duration_ms
      }
    }));
  }

  async getCurrentUser(): Promise<{ id: string; display_name: string }> {
    const response = await this.request<SpotifyTypes.SpotifyUser>(`GET`, `/me`);
    return {
      id: response.id,
      display_name: response.display_name ?? 'Unknown'
    };
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, any>,
    body?: Record<string, any>
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    }

    const response = await this.httpClient.request(method, url.toString(), {
      body: body ? JSON.stringify(body) : undefined
    });

    if (response.status === 401) {
      throw new AuthRequiredError('Spotify token expired or invalid');
    }
    if (response.status === 403) {
      throw new AccessRestrictedError('Access denied by Spotify');
    }
    if (response.status === 404) {
      throw new NotFoundError('Resource not found on Spotify');
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      // Check if this is quota exhaustion vs rate limit
      const body = response.body as any;
      if (!retryAfter && body?.error?.message?.toLowerCase().includes('quota')) {
        throw new QuotaExhaustedError('Spotify quota exceeded');
      }
      throw new RateLimitError(
        'Spotify rate limit exceeded',
        retryAfter ? parseInt(retryAfter) : 60
      );
    }
    if (response.status >= 400) {
      throw new UsageError(`Spotify API error: ${response.status}`);
    }

    return response.body as T;
  }

  private spotifyPlaylistToCanonical(playlist: SpotifyTypes.SpotifyPlaylist): PlaylistSummary {
    return {
      id: playlist.id,
      name: playlist.name,
      description: playlist.description ?? '',
      trackCount: playlist.tracks.total,
      ownerName: playlist.owner.display_name,
      ownerProviderId: playlist.owner.id,
      isPublic: playlist.public,
      thumbnail: playlist.images[0]?.url,
      ref: playlist.uri
    };
  }

  private spotifyTrackToCanonical(track: SpotifyTypes.SpotifyTrack, addedAt?: string): CanonicalTrack {
    return {
      title: track.name,
      artists: track.artists.map(a => a.name),
      album: track.album.name,
      duration: track.duration_ms,
      isrc: track.external_ids?.isrc,
      ref: track.uri,
      providerTrackId: track.id,
      addedAt: addedAt ? new Date(addedAt).toISOString() : undefined
    };
  }

  private calculateConfidence(query: string, artists: string[], track: SpotifyTypes.SpotifyTrack): number {
    // Simple title + artist matching; higher score = better match
    const titleMatch = query.toLowerCase().includes(track.name.toLowerCase()) ? 0.5 : 0;
    const artistMatch = artists.some(a => track.artists.some(ta => ta.name.toLowerCase().includes(a.toLowerCase()))) ? 0.5 : 0;
    return titleMatch + artistMatch;
  }
}
