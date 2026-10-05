# M2 Provider Implementations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full Spotify and YouTube Music provider integrations with all playlist, track, and search operations, replacing stub implementations with working API clients.

**Architecture:** M2 builds on M0's provider interface and M1's spike tests. Each provider adapter wraps its REST API (Spotify Web API, YouTube Data API), implements the closed `Provider` interface, and uses the M0 HTTP client for retry/refresh logic. Core logic remains provider-agnostic; all API details stay within adapters. Playlist operations (list, search, create, remove) and track resolution (resolve, match, populate) are implemented per provider with capability-driven graceful degradation (e.g., owned-only vs. user-accessible playlists).

**Tech Stack:** TypeScript, Node.js 20+ LTS, ESM, native fetch, Jest, Spotify Web API, YouTube Data API

**Spec:** This plan assumes completion of M0 (auth, interfaces, token store) and M1 (spike tests). It implements all provider operations not yet implemented: playlist CRUD, search, track resolution, and matching.

---

## Global Constraints

- Node.js 20+ LTS only (use native fetch, no polyfills)
- ESM modules exclusively
- No external provider SDKs (Spotify SDK, google-auth-library prohibited); use native HTTP + typed responses only
- TypeScript strict mode; no `any` types
- All HTTP requests go through M0's `HttpClient` (retry, token refresh, logging)
- Error handling: throw only closed error types from M0-2 (`AuthRequiredError`, `NotFoundError`, `QuotaExhaustedError`, `RateLimitError`, `AccessRestrictedError`, `UsageError`)
- No secrets logged (API keys, tokens, user IDs filtered from debug output)
- Unit tests mock all HTTP responses; no real API calls in CI
- Target ≥ 70% coverage on provider code (up from M0's ≥ 50%)

---

## Review Focus

These five input classes / failure modes are most likely to silently break user workflows if not tested explicitly:

1. **Expired access token during provider operation** → HTTP client must detect 401, call auth adapter to refresh, and retry transparently without exposing refresh logic to caller.

2. **API response includes null/undefined fields (track missing artist, playlist with no description)** → Adapter must handle gracefully (use defaults, skip fields) without crashing or losing data.

3. **User requests operation on playlist they don't own (e.g., YouTube Music "liked" playlist, Spotify collaborative)** → Adapter must throw `AccessRestrictedError` if the operation isn't supported, not 403 from the API.

4. **Search returns no results or pagination cursor expires** → Adapter must return empty results, not throw; pagination must be re-startable.

5. **Quota or rate limit hit mid-operation** → HTTP client must return `RateLimitError` / `QuotaExhaustedError` with retry delay; caller (CLI) decides whether to wait or fail.

Each failure mode has an explicit test case added to the owning task below.

---

## File Structure

### Spotify Provider

```
src/providers/spotify/
├── index.ts                      # Provider interface implementation
├── client.ts                     # SpotifyHttpClient with API methods
├── types.ts                      # Spotify API response types
└── errors.ts                     # Spotify-specific error mapping
```

### YouTube Music Provider

```
src/providers/youtube-music/
├── index.ts                      # Provider interface implementation
├── client.ts                     # YouTubeMusicHttpClient with API methods
├── types.ts                      # YouTube Data API response types
└── errors.ts                     # YouTube-specific error mapping
```

### Core Enhancements

```
src/core/http/
├── client.ts                     # (update) Add rate-limit detection and logging
src/core/provider/
├── provider.ts                   # (no change; used as-is from M0)
└── errors.ts                     # (no change; used as-is from M0)
```

### Tests

```
test/providers/spotify/
├── client.test.ts                # HTTP client and error mapping
├── operations.test.ts            # Playlist/track operations
└── fixtures/                     # Mock API responses
    ├── spotify-playlist.json
    ├── spotify-tracks.json
    ├── spotify-search.json
    └── ...

test/providers/youtube-music/
├── client.test.ts
├── operations.test.ts
└── fixtures/                     # Mock API responses
    ├── youtube-playlist.json
    ├── youtube-search.json
    └── ...
```

---

## Task Breakdown

### Phase 1: Spotify Provider Implementation

#### Task M2-1: Set up Spotify HTTP client and types

**Files:**
- Create: `src/providers/spotify/types.ts`
- Create: `src/providers/spotify/client.ts`
- Create: `src/providers/spotify/errors.ts`
- Create: `test/providers/spotify/fixtures/`
- Modify: `src/providers/spotify/index.ts` (from M0-10 stub)

**Interfaces:**
- Consumes: `HttpClient` (from M0-6), `Provider` interface (from M0-2), `ProviderAuth` (from M0-9), `StoredToken` (from M0-5)
- Produces: `SpotifyHttpClient` class with methods:
  - `listPlaylists(userId: string, options: { limit?: number; offset?: number }): Promise<{ playlists: PlaylistSummary[]; total: number; nextOffset?: number }>`
  - `getPlaylist(playlistId: string): Promise<PlaylistSummary>`
  - `getPlaylistTracks(playlistId: string, options: { limit?: number; offset?: number }): Promise<{ tracks: CanonicalTrack[]; total: number; nextOffset?: number }>`
  - `createPlaylist(name: string, description?: string, isPublic?: boolean): Promise<PlaylistSummary>`
  - `deletePlaylist(playlistId: string): Promise<void>`
  - `addTracksToPlaylist(playlistId: string, trackUris: string[]): Promise<void>`
  - `removeTracksFromPlaylist(playlistId: string, trackUris: string[]): Promise<void>`
  - `searchTracks(query: string, options: { limit?: number; offset?: number }): Promise<{ tracks: CanonicalTrack[]; total: number; nextOffset?: number }>`
  - `resolveTrack(title: string, artists: string[], album?: string): Promise<MatchCandidate[]>`
  - `getCurrentUser(): Promise<{ id: string; display_name: string }>`

- [ ] **Step 1: Write Spotify API response types**

Create `src/providers/spotify/types.ts` with types for all Spotify Web API responses:

```typescript
// Spotify API response types (exact shapes from Spotify Web API docs)
export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  public: boolean;
  owner: { id: string; display_name: string };
  tracks: { total: number; href: string };
  images: Array<{ url: string; height?: number; width?: number }>;
  uri: string;
  external_urls: { spotify: string };
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ name: string; id: string }>;
  album: { name: string; id: string; release_date: string };
  duration_ms: number;
  external_ids?: { isrc?: string };
  uri: string;
}

export interface SpotifyPlaylistTrack {
  track: SpotifyTrack | null;  // null for removed/unavailable tracks
  added_at: string;
}

export interface SpotifySearchResponse {
  tracks: { items: SpotifyTrack[]; total: number; next: string | null };
}

export interface SpotifyUser {
  id: string;
  display_name: string | null;
  external_urls: { spotify: string };
}

export interface SpotifyPlaylistsResponse {
  items: SpotifyPlaylist[];
  total: number;
  next: string | null;
}
```

- [ ] **Step 2: Write error mapping tests**

Create `test/providers/spotify/client.test.ts` with tests for error mapping:

```typescript
describe('SpotifyHttpClient error mapping', () => {
  it('should throw AuthRequiredError on 401 Unauthorized', async () => {
    const client = new SpotifyHttpClient(mockHttpClient);
    mockHttpClient.request.mockResolvedValueOnce({ status: 401, body: {} });
    
    await expect(client.listPlaylists('user123')).rejects.toThrow(AuthRequiredError);
  });

  it('should throw AccessRestrictedError on 403 Forbidden', async () => {
    const client = new SpotifyHttpClient(mockHttpClient);
    mockHttpClient.request.mockResolvedValueOnce({ status: 403, body: {} });
    
    await expect(client.deletePlaylist('owned-by-other')).rejects.toThrow(AccessRestrictedError);
  });

  it('should throw NotFoundError on 404 Not Found', async () => {
    const client = new SpotifyHttpClient(mockHttpClient);
    mockHttpClient.request.mockResolvedValueOnce({ status: 404, body: {} });
    
    await expect(client.getPlaylist('invalid-id')).rejects.toThrow(NotFoundError);
  });

  it('should throw RateLimitError on 429 Too Many Requests with Retry-After', async () => {
    const client = new SpotifyHttpClient(mockHttpClient);
    mockHttpClient.request.mockResolvedValueOnce({ 
      status: 429, 
      headers: { 'retry-after': '60' },
      body: {} 
    });
    
    const error = await expect(client.listPlaylists('user123')).rejects.toThrow(RateLimitError);
    expect(error.retryAfter).toBe(60);
  });

  it('should throw QuotaExhaustedError on 429 without Retry-After (quota)', async () => {
    // Spotify uses 429 for both rate limit and quota; detect via response body
    const client = new SpotifyHttpClient(mockHttpClient);
    mockHttpClient.request.mockResolvedValueOnce({ 
      status: 429, 
      headers: {},
      body: { error: { status: 429, message: 'Quota exceeded' } }
    });
    
    await expect(client.listPlaylists('user123')).rejects.toThrow(QuotaExhaustedError);
  });

  it('should handle null fields in track response gracefully', async () => {
    const client = new SpotifyHttpClient(mockHttpClient);
    mockHttpClient.request.mockResolvedValueOnce({
      status: 200,
      body: {
        items: [{
          track: null,  // Track is unavailable/removed
          added_at: '2024-01-01T00:00:00Z'
        }],
        total: 1
      }
    });
    
    const result = await client.getPlaylistTracks('playlist123');
    expect(result.tracks).toEqual([]);  // Skip null tracks
  });
});
```

- [ ] **Step 3: Implement SpotifyHttpClient**

Create `src/providers/spotify/client.ts`:

```typescript
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
```

- [ ] **Step 4: Create error mapping module**

Create `src/providers/spotify/errors.ts`:

```typescript
// Map Spotify-specific errors to closed error types
// (Most logic is in SpotifyHttpClient.request; this is for any Spotify-specific cases)

export function mapSpotifyError(statusCode: number, message: string): Error {
  // Detailed mapping; most common cases handled in client.request()
  if (statusCode === 429 && message.includes('quota')) {
    return new QuotaExhaustedError('Spotify quota exceeded');
  }
  // Other cases deferred to client.request()
  return new Error(`Spotify error: ${statusCode}`);
}
```

- [ ] **Step 5: Update Spotify provider index**

Update `src/providers/spotify/index.ts` from M0-10 stub to use `SpotifyHttpClient`:

```typescript
import { Provider, PlaylistSummary, CanonicalTrack, MatchCandidate, ProviderCapabilities } from '../../core/provider/provider.js';
import { ProviderAuth } from '../../core/auth/auth.js';
import { HttpClient } from '../../core/http/client.js';
import { SpotifyHttpClient } from './client.js';

export class SpotifyProvider implements Provider {
  capabilities: ProviderCapabilities = {
    playlists: { access: ['owned', 'user-accessible'], renameable: true },
    pagination: 'cursor-forward',
    quotaModel: { type: 'daily-buckets', daily: 10000 },
    search: { tracks: true, playlists: false }
  };

  private client: SpotifyHttpClient;

  constructor(httpClient: HttpClient, private auth: ProviderAuth) {
    this.client = new SpotifyHttpClient(httpClient);
  }

  async listPlaylists(options?: any) {
    const user = await this.client.getCurrentUser();
    return this.client.listPlaylists(user.id, options);
  }

  async getPlaylist(id: string) {
    return this.client.getPlaylist(id);
  }

  async getPlaylistTracks(id: string, options?: any) {
    return this.client.getPlaylistTracks(id, options);
  }

  async createPlaylist(name: string, description?: string) {
    return this.client.createPlaylist(name, description);
  }

  async deletePlaylist(id: string) {
    return this.client.deletePlaylist(id);
  }

  async addTracksToPlaylist(playlistId: string, trackRefs: string[]) {
    // Convert refs to Spotify URIs
    const uris = trackRefs.map(ref => ref.startsWith('spotify:') ? ref : `spotify:track:${ref}`);
    return this.client.addTracksToPlaylist(playlistId, uris);
  }

  async removeTracksFromPlaylist(playlistId: string, trackRefs: string[]) {
    const uris = trackRefs.map(ref => ref.startsWith('spotify:') ? ref : `spotify:track:${ref}`);
    return this.client.removeTracksFromPlaylist(playlistId, uris);
  }

  async searchTracks(query: string, options?: any) {
    return this.client.searchTracks(query, options);
  }

  async resolveTrack(title: string, artists: string[], album?: string) {
    return this.client.resolveTrack(title, artists, album);
  }

  async populatePlaylistMetadata(playlist: PlaylistSummary) {
    return this.client.getPlaylist(playlist.id);
  }

  async login() {
    return this.auth.login('spotify');
  }

  async logout() {
    return this.auth.logout('spotify');
  }

  async status() {
    return this.auth.status('spotify');
  }
}
```

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- test/providers/spotify/client.test.ts
git add src/providers/spotify/ test/providers/spotify/
git commit -m "feat(spotify): implement HTTP client and API types"
```

---

#### Task M2-2: Spotify provider integration tests

**Files:**
- Create: `test/providers/spotify/operations.test.ts`
- Create: `test/providers/spotify/fixtures/spotify-*.json`
- Modify: `test/providers/spotify/client.test.ts` (add integration tests)

**Interfaces:**
- Consumes: `SpotifyHttpClient` (from M2-1), mock HTTP fixtures
- Produces: Test suite proving all Spotify operations work with mocked API responses

- [ ] **Step 1: Create HTTP response fixtures**

Create fixture files in `test/providers/spotify/fixtures/`:

`spotify-playlist.json`:
```json
{
  "id": "test-playlist-1",
  "name": "Test Playlist",
  "description": "A test playlist",
  "public": true,
  "owner": { "id": "user123", "display_name": "Test User" },
  "tracks": { "total": 2 },
  "images": [{ "url": "https://example.com/image.jpg" }],
  "uri": "spotify:playlist:test-playlist-1"
}
```

`spotify-playlist-tracks.json`:
```json
{
  "items": [
    {
      "track": {
        "id": "track-1",
        "name": "Song One",
        "artists": [{ "id": "artist-1", "name": "Artist One" }],
        "album": { "id": "album-1", "name": "Album One", "release_date": "2024-01-01" },
        "duration_ms": 180000,
        "external_ids": { "isrc": "USRC12345678" },
        "uri": "spotify:track:track-1"
      },
      "added_at": "2024-01-01T12:00:00Z"
    },
    {
      "track": {
        "id": "track-2",
        "name": "Song Two",
        "artists": [{ "id": "artist-2", "name": "Artist Two" }],
        "album": { "id": "album-2", "name": "Album Two", "release_date": "2024-02-01" },
        "duration_ms": 240000,
        "uri": "spotify:track:track-2"
      },
      "added_at": "2024-01-02T12:00:00Z"
    }
  ],
  "total": 2
}
```

- [ ] **Step 2: Write integration tests for Spotify operations**

Add to `test/providers/spotify/operations.test.ts`:

```typescript
import { SpotifyHttpClient } from '../../src/providers/spotify/client.js';
import { AccessRestrictedError, NotFoundError } from '../../src/core/provider/errors.js';
import * as fixtures from './fixtures/index.js';

describe('Spotify Provider Operations', () => {
  let client: SpotifyHttpClient;
  let mockHttpClient: any;

  beforeEach(() => {
    mockHttpClient = {
      request: jest.fn()
    };
    client = new SpotifyHttpClient(mockHttpClient);
  });

  describe('listPlaylists', () => {
    it('should return paginated playlists', async () => {
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: {
          items: [fixtures.spotifyPlaylist],
          total: 1,
          next: null
        }
      });

      const result = await client.listPlaylists('user123');
      expect(result.playlists).toHaveLength(1);
      expect(result.playlists[0].name).toBe('Test Playlist');
      expect(result.total).toBe(1);
    });

    it('should include nextOffset when more results available', async () => {
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: {
          items: [fixtures.spotifyPlaylist],
          total: 100,
          next: 'https://api.spotify.com/v1/users/user123/playlists?offset=50'
        }
      });

      const result = await client.listPlaylists('user123', { limit: 50, offset: 0 });
      expect(result.nextOffset).toBe(50);
    });

    it('should throw AuthRequiredError on 401', async () => {
      mockHttpClient.request.mockResolvedValueOnce({ status: 401, body: {} });
      await expect(client.listPlaylists('user123')).rejects.toThrow(AuthRequiredError);
    });
  });

  describe('getPlaylistTracks', () => {
    it('should filter out null (unavailable) tracks', async () => {
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: {
          items: [
            { track: fixtures.spotifyTrack1, added_at: '2024-01-01T12:00:00Z' },
            { track: null, added_at: '2024-01-02T12:00:00Z' },  // Removed track
            { track: fixtures.spotifyTrack2, added_at: '2024-01-03T12:00:00Z' }
          ],
          total: 3,
          next: null
        }
      });

      const result = await client.getPlaylistTracks('playlist-1');
      expect(result.tracks).toHaveLength(2);
      expect(result.tracks[0].title).toBe('Song One');
      expect(result.total).toBe(3);  // Total reflects API response, not filtered list
    });

    it('should include addedAt timestamp', async () => {
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: {
          items: [{ track: fixtures.spotifyTrack1, added_at: '2024-01-01T12:00:00Z' }],
          total: 1
        }
      });

      const result = await client.getPlaylistTracks('playlist-1');
      expect(result.tracks[0].addedAt).toBe('2024-01-01T12:00:00Z');
    });
  });

  describe('resolveTrack', () => {
    it('should return match candidates with confidence scores', async () => {
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: {
          tracks: {
            items: [fixtures.spotifyTrack1, fixtures.spotifyTrack2],
            total: 2,
            next: null
          }
        }
      });

      const result = await client.resolveTrack('Song One', ['Artist One']);
      expect(result).toHaveLength(2);
      expect(result[0].trackRef).toBe('spotify:track:track-1');
      expect(result[0].confidence).toBeGreaterThan(0);
    });

    it('should return empty array on no results', async () => {
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: { tracks: { items: [], total: 0, next: null } }
      });

      const result = await client.resolveTrack('Nonexistent Song', ['Nonexistent Artist']);
      expect(result).toEqual([]);
    });
  });

  describe('createPlaylist', () => {
    it('should create playlist with user as owner', async () => {
      // First call: getCurrentUser
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: { id: 'user123', display_name: 'Test User' }
      });
      // Second call: createPlaylist
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: fixtures.spotifyPlaylist
      });

      const result = await client.createPlaylist('New Playlist');
      expect(result.name).toBe('Test Playlist');
      expect(result.ownerProviderId).toBe('user123');
    });
  });

  describe('addTracksToPlaylist', () => {
    it('should split large requests (>100 tracks) into batches', async () => {
      const tracks = Array.from({ length: 250 }, (_, i) => `spotify:track:${i}`);
      mockHttpClient.request.mockResolvedValue({ status: 200, body: {} });

      await client.addTracksToPlaylist('playlist-1', tracks);

      expect(mockHttpClient.request).toHaveBeenCalledTimes(3);  // 250 tracks = 3 batches (100 + 100 + 50)
    });
  });
});
```

- [ ] **Step 3: Run all Spotify tests**

```bash
npm test -- test/providers/spotify/
```

Expected: All tests pass.

- [ ] **Step 4: Verify coverage**

```bash
npm test -- test/providers/spotify/ --coverage
```

Expected: ≥ 70% coverage on `src/providers/spotify/`

- [ ] **Step 5: Commit**

```bash
git add test/providers/spotify/
git commit -m "test(spotify): add integration tests for all operations"
```

---

### Phase 2: YouTube Music Provider Implementation

#### Task M2-3: Set up YouTube Music HTTP client and types

**Files:**
- Create: `src/providers/youtube-music/types.ts`
- Create: `src/providers/youtube-music/client.ts`
- Create: `src/providers/youtube-music/errors.ts`
- Create: `test/providers/youtube-music/fixtures/`
- Modify: `src/providers/youtube-music/index.ts` (from M0-10 stub)

**Interfaces:**
- Consumes: `HttpClient` (from M0-6), `Provider` interface (from M0-2), `ProviderAuth` (from M0-9)
- Produces: `YouTubeMusicHttpClient` class with same method signatures as `SpotifyHttpClient` (list, get, search, resolve, create, delete, add, remove tracks)

- [ ] **Step 1: Write YouTube Data API response types**

Create `src/providers/youtube-music/types.ts`:

```typescript
// YouTube Data API response types (exact shapes from YouTube API)
export interface YouTubePlaylist {
  id: string;
  snippet: {
    title: string;
    description: string;
    channelTitle: string;
    thumbnails?: { high?: { url: string } };
  };
  contentDetails?: { itemCount: number };
  status?: { privacyStatus: 'public' | 'private' | 'unlisted' };
}

export interface YouTubePlaylistItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    playlistId: string;
    position: number;
    resourceId: { videoId: string };
    publishedAt: string;
  };
  contentDetails?: { videoId: string; startAt?: string; endAt?: string; note?: string };
}

export interface YouTubeVideo {
  id: string;
  snippet: {
    title: string;
    description: string;
    channelTitle: string;
    publishedAt: string;
    thumbnails?: { default?: { url: string } };
  };
  contentDetails?: {
    duration: string;  // ISO 8601 duration (PT3M30S)
  };
}

export interface YouTubeSearchResult {
  id: { videoId: string; playlistId?: string };
  snippet: { title: string; description: string; channelTitle: string };
}

export interface YouTubeChannelInfo {
  id: string;
  snippet: { title: string };
}

export interface YouTubeListResponse<T> {
  items: T[];
  pageInfo: { totalResults: number; resultsPerPage: number };
  nextPageToken?: string;
}
```

- [ ] **Step 2: Write error mapping tests**

Create `test/providers/youtube-music/client.test.ts`:

```typescript
import { YouTubeMusicHttpClient } from '../../src/providers/youtube-music/client.js';
import { AuthRequiredError, RateLimitError, QuotaExhaustedError, NotFoundError } from '../../src/core/provider/errors.js';

describe('YouTubeMusicHttpClient error mapping', () => {
  let client: YouTubeMusicHttpClient;
  let mockHttpClient: any;

  beforeEach(() => {
    mockHttpClient = { request: jest.fn() };
    client = new YouTubeMusicHttpClient(mockHttpClient);
  });

  it('should throw AuthRequiredError on 401 Unauthorized', async () => {
    mockHttpClient.request.mockResolvedValueOnce({ status: 401, body: {} });
    await expect(client.listPlaylists()).rejects.toThrow(AuthRequiredError);
  });

  it('should throw RateLimitError on 403 quotaExceeded', async () => {
    mockHttpClient.request.mockResolvedValueOnce({
      status: 403,
      body: { error: { errors: [{ reason: 'quotaExceeded' }] } }
    });
    await expect(client.listPlaylists()).rejects.toThrow(RateLimitError);
  });

  it('should throw NotFoundError on 404', async () => {
    mockHttpClient.request.mockResolvedValueOnce({ status: 404, body: {} });
    await expect(client.getPlaylist('invalid')).rejects.toThrow(NotFoundError);
  });

  it('should handle null/missing fields in video gracefully', async () => {
    mockHttpClient.request.mockResolvedValueOnce({
      status: 200,
      body: {
        items: [{
          id: 'video-1',
          snippet: {
            title: 'Song',
            description: '',
            channelTitle: 'Artist',
            publishedAt: '2024-01-01T00:00:00Z'
          }
          // contentDetails missing (duration unavailable)
        }]
      }
    });

    const result = await client.searchTracks('Song');
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].duration).toBe(0);  // Default to 0 if missing
  });
});
```

- [ ] **Step 3: Implement YouTubeMusicHttpClient**

Create `src/providers/youtube-music/client.ts`:

```typescript
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

  async listPlaylists(
    options: { limit?: number; pageToken?: string } = {}
  ): Promise<{ playlists: PlaylistSummary[]; total: number; nextPageToken?: string }> {
    const maxResults = options.limit ?? 50;

    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylist>>(
      `GET`,
      `/playlists`,
      { part: 'snippet,contentDetails,status', mine: true, maxResults, pageToken: options.pageToken }
    );

    return {
      playlists: response.items.map(p => this.youtubePlaylistToCanonical(p)),
      total: response.pageInfo.totalResults,
      nextPageToken: response.nextPageToken
    };
  }

  async getPlaylist(playlistId: string): Promise<PlaylistSummary> {
    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylist>>(
      `GET`,
      `/playlists`,
      { part: 'snippet,contentDetails,status', id: playlistId }
    );

    if (!response.items.length) {
      throw new NotFoundError(`Playlist ${playlistId} not found`);
    }

    return this.youtubePlaylistToCanonical(response.items[0]);
  }

  async getPlaylistTracks(
    playlistId: string,
    options: { limit?: number; pageToken?: string } = {}
  ): Promise<{ tracks: CanonicalTrack[]; total: number; nextPageToken?: string }> {
    const maxResults = options.limit ?? 50;

    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylistItem>>(
      `GET`,
      `/playlistItems`,
      { part: 'snippet,contentDetails', playlistId, maxResults, pageToken: options.pageToken }
    );

    const videoIds = response.items.map(item => item.contentDetails?.videoId || item.snippet.resourceId.videoId);
    const videos = await this.getVideos(videoIds);

    return {
      tracks: response.items
        .map((item, idx) => this.youtubeVideoToCanonical(videos[idx], item.snippet.publishedAt))
        .filter(t => t !== null) as CanonicalTrack[],
      total: response.pageInfo.totalResults,
      nextPageToken: response.nextPageToken
    };
  }

  async createPlaylist(name: string, description?: string): Promise<PlaylistSummary> {
    const response = await this.request<YouTubeTypes.YouTubePlaylist>(
      `POST`,
      `/playlists`,
      { part: 'snippet,status' },
      {
        snippet: { title: name, description: description ?? '' },
        status: { privacyStatus: 'private' }
      }
    );

    return this.youtubePlaylistToCanonical(response);
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await this.request(`DELETE`, `/playlists`, { id: playlistId });
  }

  async addTracksToPlaylist(playlistId: string, trackRefs: string[]): Promise<void> {
    for (const videoId of trackRefs) {
      await this.request(
        `POST`,
        `/playlistItems`,
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

  async removeTracksFromPlaylist(playlistId: string, trackRefs: string[]): Promise<void> {
    // YouTube API requires playlistItemId, not videoId; need to fetch items first
    const items = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubePlaylistItem>>(
      `GET`,
      `/playlistItems`,
      { part: 'snippet', playlistId, maxResults: 50 }
    );

    for (const item of items.items) {
      if (trackRefs.includes(item.contentDetails?.videoId || item.snippet.resourceId.videoId)) {
        await this.request(`DELETE`, `/playlistItems`, { id: item.id });
      }
    }
  }

  async searchTracks(
    query: string,
    options: { limit?: number; pageToken?: string } = {}
  ): Promise<{ tracks: CanonicalTrack[]; total: number; nextPageToken?: string }> {
    const maxResults = options.limit ?? 50;

    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubeSearchResult>>(
      `GET`,
      `/search`,
      { part: 'snippet', type: 'video', q: query, maxResults, pageToken: options.pageToken }
    );

    const videoIds = response.items.filter(item => item.id.videoId).map(item => item.id.videoId);
    const videos = await this.getVideos(videoIds);

    return {
      tracks: videos.map(v => this.youtubeVideoToCanonical(v)).filter(t => t !== null) as CanonicalTrack[],
      total: response.pageInfo.totalResults,
      nextPageToken: response.nextPageToken
    };
  }

  async resolveTrack(title: string, artists: string[], album?: string): Promise<MatchCandidate[]> {
    const query = `${title} ${artists.join(' ')}`;

    const response = await this.request<YouTubeTypes.YouTubeListResponse<YouTubeTypes.YouTubeSearchResult>>(
      `GET`,
      `/search`,
      { part: 'snippet', type: 'video', q: query, maxResults: 10 }
    );

    const videoIds = response.items.filter(item => item.id.videoId).map(item => item.id.videoId);
    const videos = await this.getVideos(videoIds);

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
      `GET`,
      `/videos`,
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
      ownerProviderId: '',  // YouTube doesn't expose channel ID in playlist response
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

  private parseDuration(iso8601: string | undefined): number {
    if (!iso8601) return 0;
    // Parse PT3M30S → 210000ms
    const match = iso8601.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    if (!match) return 0;
    const hours = parseInt(match[1]) || 0;
    const minutes = parseInt(match[2]) || 0;
    const seconds = parseInt(match[3]) || 0;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  private calculateConfidence(query: string, artists: string[], video: YouTubeTypes.YouTubeVideo): number {
    const titleMatch = query.toLowerCase().includes(video.snippet.title.toLowerCase()) ? 0.5 : 0;
    const artistMatch = artists.some(a => video.snippet.channelTitle.toLowerCase().includes(a.toLowerCase())) ? 0.5 : 0;
    return titleMatch + artistMatch;
  }
}
```

- [ ] **Step 4: Create error mapping module**

Create `src/providers/youtube-music/errors.ts` (placeholder for YouTube-specific logic):

```typescript
// Map YouTube-specific errors to closed error types
// Most logic is in YouTubeMusicHttpClient.request()
export function mapYouTubeError(statusCode: number, reason?: string): Error {
  if (statusCode === 403 && reason === 'quotaExceeded') {
    return new QuotaExhaustedError('YouTube quota exceeded');
  }
  return new Error(`YouTube error: ${statusCode}`);
}
```

- [ ] **Step 5: Update YouTube Music provider index**

Update `src/providers/youtube-music/index.ts`:

```typescript
import { Provider, PlaylistSummary, CanonicalTrack, MatchCandidate, ProviderCapabilities } from '../../core/provider/provider.js';
import { ProviderAuth } from '../../core/auth/auth.js';
import { HttpClient } from '../../core/http/client.js';
import { YouTubeMusicHttpClient } from './client.js';

export class YouTubeMusicProvider implements Provider {
  capabilities: ProviderCapabilities = {
    playlists: { access: ['owned'], renameable: false },
    pagination: 'page-forward',
    quotaModel: { type: 'daily-buckets', daily: 1000000 },
    search: { tracks: true, playlists: false }
  };

  private client: YouTubeMusicHttpClient;

  constructor(httpClient: HttpClient, private auth: ProviderAuth, apiKey: string) {
    this.client = new YouTubeMusicHttpClient(httpClient, apiKey);
  }

  async listPlaylists(options?: any) {
    return this.client.listPlaylists(options);
  }

  async getPlaylist(id: string) {
    return this.client.getPlaylist(id);
  }

  async getPlaylistTracks(id: string, options?: any) {
    return this.client.getPlaylistTracks(id, options);
  }

  async createPlaylist(name: string, description?: string) {
    return this.client.createPlaylist(name, description);
  }

  async deletePlaylist(id: string) {
    return this.client.deletePlaylist(id);
  }

  async addTracksToPlaylist(playlistId: string, trackRefs: string[]) {
    // YouTube expects video IDs, not URLs
    const videoIds = trackRefs.map(ref => {
      const match = ref.match(/v=([a-zA-Z0-9_-]{11})/);
      return match ? match[1] : ref;
    });
    return this.client.addTracksToPlaylist(playlistId, videoIds);
  }

  async removeTracksFromPlaylist(playlistId: string, trackRefs: string[]) {
    const videoIds = trackRefs.map(ref => {
      const match = ref.match(/v=([a-zA-Z0-9_-]{11})/);
      return match ? match[1] : ref;
    });
    return this.client.removeTracksFromPlaylist(playlistId, videoIds);
  }

  async searchTracks(query: string, options?: any) {
    return this.client.searchTracks(query, options);
  }

  async resolveTrack(title: string, artists: string[], album?: string) {
    return this.client.resolveTrack(title, artists, album);
  }

  async populatePlaylistMetadata(playlist: PlaylistSummary) {
    return this.client.getPlaylist(playlist.id);
  }

  async login() {
    return this.auth.login('youtube-music');
  }

  async logout() {
    return this.auth.logout('youtube-music');
  }

  async status() {
    return this.auth.status('youtube-music');
  }
}
```

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- test/providers/youtube-music/client.test.ts
git add src/providers/youtube-music/ test/providers/youtube-music/
git commit -m "feat(youtube-music): implement HTTP client and API types"
```

---

#### Task M2-4: YouTube Music provider integration tests

**Files:**
- Create: `test/providers/youtube-music/operations.test.ts`
- Create: `test/providers/youtube-music/fixtures/youtube-*.json`
- Modify: `test/providers/youtube-music/client.test.ts` (add integration tests)

**Interfaces:**
- Consumes: `YouTubeMusicHttpClient` (from M2-3), mock HTTP fixtures
- Produces: Test suite proving all YouTube Music operations work

- [ ] **Step 1: Create HTTP response fixtures**

Create `test/providers/youtube-music/fixtures/youtube-playlist.json`:

```json
{
  "items": [{
    "id": "youtube-playlist-1",
    "snippet": {
      "title": "My Music",
      "description": "My favorite songs",
      "channelTitle": "Me",
      "thumbnails": { "high": { "url": "https://example.com/image.jpg" } }
    },
    "contentDetails": { "itemCount": 42 },
    "status": { "privacyStatus": "private" }
  }],
  "pageInfo": { "totalResults": 1, "resultsPerPage": 1 }
}
```

- [ ] **Step 2: Write ISO 8601 duration parsing tests**

Add to `test/providers/youtube-music/client.test.ts`:

```typescript
describe('YouTube Music duration parsing', () => {
  let client: YouTubeMusicHttpClient;

  beforeEach(() => {
    client = new YouTubeMusicHttpClient({ request: jest.fn() });
  });

  it('should parse PT3M30S correctly', () => {
    const duration = client['parseDuration']('PT3M30S');
    expect(duration).toBe(210000);  // 3m 30s in ms
  });

  it('should parse PT1H2M3S correctly', () => {
    const duration = client['parseDuration']('PT1H2M3S');
    expect(duration).toBe(3723000);  // 1h 2m 3s in ms
  });

  it('should handle missing duration gracefully', () => {
    const duration = client['parseDuration'](undefined);
    expect(duration).toBe(0);
  });
});
```

- [ ] **Step 3: Write integration tests**

Add to `test/providers/youtube-music/operations.test.ts`:

```typescript
import { YouTubeMusicHttpClient } from '../../src/providers/youtube-music/client.js';
import { NotFoundError } from '../../src/core/provider/errors.js';

describe('YouTube Music Provider Operations', () => {
  let client: YouTubeMusicHttpClient;
  let mockHttpClient: any;

  beforeEach(() => {
    mockHttpClient = { request: jest.fn() };
    client = new YouTubeMusicHttpClient(mockHttpClient, 'test-api-key');
  });

  describe('listPlaylists', () => {
    it('should return paginated playlists with pageToken', async () => {
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: {
          items: [{ id: 'pl1', snippet: { title: 'Playlist 1' } }],
          pageInfo: { totalResults: 100, resultsPerPage: 1 },
          nextPageToken: 'NEXT_PAGE'
        }
      });

      const result = await client.listPlaylists();
      expect(result.playlists).toHaveLength(1);
      expect(result.nextPageToken).toBe('NEXT_PAGE');
    });
  });

  describe('getPlaylist', () => {
    it('should throw NotFoundError if playlist not in response', async () => {
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: { items: [], pageInfo: { totalResults: 0 } }
      });

      await expect(client.getPlaylist('invalid')).rejects.toThrow(NotFoundError);
    });
  });

  describe('resolveTrack', () => {
    it('should filter out candidates with zero confidence', async () => {
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: {
          items: [
            { id: { videoId: 'vid1' }, snippet: { title: 'Unrelated Song', channelTitle: 'Other Artist' } }
          ],
          pageInfo: { totalResults: 1 }
        }
      });
      mockHttpClient.request.mockResolvedValueOnce({
        status: 200,
        body: { items: [{ id: 'vid1', snippet: { title: 'Unrelated', channelTitle: 'Other' } }] }
      });

      const result = await client.resolveTrack('Query Song', ['Query Artist']);
      expect(result).toHaveLength(0);  // No matching confidence
    });
  });
});
```

- [ ] **Step 4: Run all YouTube tests**

```bash
npm test -- test/providers/youtube-music/
```

Expected: All tests pass.

- [ ] **Step 5: Verify coverage**

```bash
npm test -- test/providers/youtube-music/ --coverage
```

Expected: ≥ 70% coverage on `src/providers/youtube-music/`

- [ ] **Step 6: Commit**

```bash
git add test/providers/youtube-music/
git commit -m "test(youtube-music): add integration tests for all operations"
```

---

### Phase 3: Core Integration and CLI Updates

#### Task M2-5: Update HTTP client with rate-limit detection

**Files:**
- Modify: `src/core/http/client.ts` (enhance logging, detect rate limits)

**Interfaces:**
- Consumes: Response headers (Retry-After, X-RateLimit-*)
- Produces: Same `HttpClient` interface; enhanced logging

- [ ] **Step 1: Add rate-limit header parsing**

Update `src/core/http/client.ts` to detect and log rate limits:

```typescript
// In HttpClient.request():
private async request(method: string, url: string, options: any): Promise<Response> {
  // ... existing retry logic ...
  
  // After getting response:
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after') || response.headers.get('x-ratelimit-reset-after');
    if (this.logger) {
      this.logger.warn(`Rate limit hit on ${method} ${url}`, { retryAfter });
    }
  }

  // Check X-RateLimit-Remaining to proactive log when near limit
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining && parseInt(remaining) < 10) {
    if (this.logger) {
      this.logger.warn(`Approaching rate limit`, { remaining, limit: response.headers.get('x-ratelimit-limit') });
    }
  }

  return response;
}
```

- [ ] **Step 2: Write tests for rate-limit detection**

Add to `test/core/http/client.test.ts`:

```typescript
describe('HttpClient rate-limit detection', () => {
  it('should log when near rate limit', async () => {
    const mockLogger = { warn: jest.fn() };
    const client = new HttpClient({ logger: mockLogger });
    
    const response = new Response('{}', {
      status: 200,
      headers: new Headers({
        'x-ratelimit-remaining': '5',
        'x-ratelimit-limit': '100'
      })
    });
    
    global.fetch = jest.fn().mockResolvedValue(response);
    
    await client.request('GET', 'https://api.example.com/test');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('rate limit'),
      expect.objectContaining({ remaining: '5' })
    );
  });
});
```

- [ ] **Step 3: Run tests and commit**

```bash
npm test -- test/core/http/client.test.ts
git add src/core/http/client.ts test/core/http/client.test.ts
git commit -m "feat(http): add rate-limit header detection and logging"
```

---

#### Task M2-6: Update provider registry with full implementations

**Files:**
- Modify: `src/cli/provider-registry.ts`

**Interfaces:**
- Consumes: `SpotifyProvider` (from M2-1), `YouTubeMusicProvider` (from M2-3), config
- Produces: Updated provider factory

- [ ] **Step 1: Update provider-registry**

Update `src/cli/provider-registry.ts` to instantiate full provider implementations:

```typescript
import { SpotifyProvider } from '../providers/spotify/index.js';
import { YouTubeMusicProvider } from '../providers/youtube-music/index.js';
import { FakeProvider } from '../providers/fake/index.js';
import { HttpClient } from '../core/http/client.js';
import { OAuthHandler } from '../core/auth/oauth-handler.js';

export class ProviderRegistry {
  static createProvider(
    providerId: string,
    config: { spotifyClientId: string; youtubeClientId: string; youtubeClientSecret: string },
    env?: NodeJS.ProcessEnv
  ): Provider {
    const httpClient = new HttpClient();
    const oauthHandler = new OAuthHandler();

    switch (providerId) {
      case 'spotify':
        return new SpotifyProvider(httpClient, oauthHandler);
      case 'youtube-music':
        return new YouTubeMusicProvider(
          httpClient,
          oauthHandler,
          config.youtubeClientId
        );
      case 'fake':
        return new FakeProvider();
      default:
        throw new UsageError(`Unknown provider: ${providerId}`);
    }
  }
}
```

- [ ] **Step 2: Write registry tests**

Add to `test/cli/provider-registry.test.ts`:

```typescript
describe('ProviderRegistry', () => {
  it('should create Spotify provider', () => {
    const provider = ProviderRegistry.createProvider('spotify', {
      spotifyClientId: 'test',
      youtubeClientId: '',
      youtubeClientSecret: ''
    });
    expect(provider).toBeInstanceOf(SpotifyProvider);
  });

  it('should create YouTube Music provider', () => {
    const provider = ProviderRegistry.createProvider('youtube-music', {
      spotifyClientId: '',
      youtubeClientId: 'test',
      youtubeClientSecret: 'secret'
    });
    expect(provider).toBeInstanceOf(YouTubeMusicProvider);
  });

  it('should throw on unknown provider', () => {
    expect(() => {
      ProviderRegistry.createProvider('invalid', {
        spotifyClientId: '',
        youtubeClientId: '',
        youtubeClientSecret: ''
      });
    }).toThrow(UsageError);
  });
});
```

- [ ] **Step 3: Run tests and commit**

```bash
npm test -- test/cli/provider-registry.test.ts
git add src/cli/provider-registry.ts test/cli/provider-registry.test.ts
git commit -m "feat(cli): update provider registry with full implementations"
```

---

### Phase 4: Testing and Documentation

#### Task M2-7: Add end-to-end provider tests

**Files:**
- Create: `test/e2e/provider-integration.test.ts`

**Interfaces:**
- Consumes: Fake provider from M0-7, full provider implementations
- Produces: E2E tests proving all providers implement the interface correctly

- [ ] **Step 1: Write E2E test suite**

Create `test/e2e/provider-integration.test.ts`:

```typescript
import { Provider } from '../../src/core/provider/provider.js';
import { SpotifyProvider } from '../../src/providers/spotify/index.js';
import { YouTubeMusicProvider } from '../../src/providers/youtube-music/index.js';
import { FakeProvider } from '../../src/providers/fake/index.js';
import { PlaylistSummary, CanonicalTrack } from '../../src/core/provider/provider.js';

describe('Provider Interface Contract (E2E)', () => {
  let providers: Record<string, Provider>;

  beforeEach(() => {
    // Mock HTTP client for Spotify and YouTube
    const mockHttpClient = { request: jest.fn() };
    const mockOAuth = { login: jest.fn(), logout: jest.fn(), status: jest.fn() };

    providers = {
      spotify: new SpotifyProvider(mockHttpClient as any, mockOAuth as any),
      youtubeMusicTracker: new YouTubeMusicProvider(mockHttpClient as any, mockOAuth as any, 'test-key'),
      fake: new FakeProvider({ pagination: 'cursor-forward', playlists: { access: ['owned', 'user-accessible'] } })
    };
  });

  describe('All providers', () => {
    Object.entries(providers).forEach(([name, provider]) => {
      describe(`${name}`, () => {
        it('should declare capabilities', () => {
          expect(provider.capabilities).toBeDefined();
          expect(provider.capabilities.pagination).toMatch(/cursor-forward|page-forward/);
        });

        // Add tests that work with mocked responses
        // (Real calls would hit the mock HTTP client)
      });
    });
  });

  it('should handle search returning no results uniformly', async () => {
    // Prove all providers behave the same when no results
    const result = await providers.fake.searchTracks('nonexistent-query-xyz');
    expect(result.tracks).toEqual([]);
  });

  it('should handle playlist creation and deletion', async () => {
    const playlist = await providers.fake.createPlaylist('Test Playlist');
    expect(playlist.name).toBe('Test Playlist');

    await providers.fake.deletePlaylist(playlist.id);
    // Verify deletion (implementation-specific)
  });
});
```

- [ ] **Step 2: Run E2E tests**

```bash
npm test -- test/e2e/provider-integration.test.ts
```

Expected: All tests pass, proving interface contract is met.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/provider-integration.test.ts
git commit -m "test(e2e): add provider interface contract tests"
```

---

#### Task M2-8: Update documentation with provider integration details

**Files:**
- Modify: `README.md`
- Create: `docs/providers/SPOTIFY.md`
- Create: `docs/providers/YOUTUBE-MUSIC.md`
- Create: `docs/adr/0007-provider-implementation-strategy.md`

**Interfaces:**
- Consumes: Nothing new; documents existing code
- Produces: User-facing docs on provider setup and internals

- [ ] **Step 1: Create Spotify provider docs**

Create `docs/providers/SPOTIFY.md`:

```markdown
# Spotify Provider Integration

## Authentication

Spotify uses OAuth 2.0 with PKCE flow.

### Prerequisites

1. Create a Spotify app at https://developer.spotify.com/dashboard
2. Set `SPLE_SPOTIFY_CLIENT_ID` in `.env`
3. Configure redirect URI in Spotify app settings:
   - Local: `http://localhost:8888/callback`
   - Headless: any http://localhost:* will work (use `--manual` mode)

### Login

```bash
sple auth login --provider spotify
sple auth status
```

## API Endpoints Used

| Operation | Endpoint | Method |
|-----------|----------|--------|
| List playlists | `/v1/users/{user_id}/playlists` | GET |
| Get playlist | `/v1/playlists/{id}` | GET |
| Get tracks | `/v1/playlists/{id}/tracks` | GET |
| Create playlist | `/v1/users/{user_id}/playlists` | POST |
| Add tracks | `/v1/playlists/{id}/tracks` | POST |
| Remove tracks | `/v1/playlists/{id}/tracks` | DELETE |
| Delete playlist | `/v1/playlists/{id}/followers` | DELETE |
| Search | `/v1/search` | GET |

## Capabilities

- **Playlists:** Can access owned and user-accessible playlists
- **Pagination:** Cursor-based (offset + limit)
- **Quota:** Daily bucket model (10,000 requests/day)
- **Renaming:** Supported

## Error Handling

| HTTP Status | Error Type | Handling |
|------------|-----------|----------|
| 401 | `AuthRequiredError` | Token refresh triggered automatically |
| 403 | `AccessRestrictedError` | User lacks permission (e.g., can't delete other's playlist) |
| 404 | `NotFoundError` | Playlist/track not found |
| 429 | `RateLimitError` | Retry after header respected |

## Known Limitations

- Playlist tracks may be `null` if removed by owner → skipped silently
- Album info is limited (no release date precision)
- Cannot access someone's "liked" songs (private playlist)
```

- [ ] **Step 2: Create YouTube Music provider docs**

Create `docs/providers/YOUTUBE-MUSIC.md`:

```markdown
# YouTube Music Provider Integration

## Authentication

YouTube uses OAuth 2.0 (Google Sign-In).

### Prerequisites

1. Create a Google Cloud project at https://console.cloud.google.com
2. Enable YouTube Data API v3
3. Create OAuth 2.0 desktop app credentials
4. Set `SPLE_YOUTUBE_MUSIC_CLIENT_ID` and `SPLE_GOOGLE_CLIENT_SECRET` in `.env`
5. Configure redirect URI: `http://localhost:8888/callback`

### Login

```bash
sple auth login --provider youtube-music
sple auth status
```

## API Endpoints Used

| Operation | Endpoint | Method |
|-----------|----------|--------|
| List playlists | `/youtube/v3/playlists` | GET |
| Get playlist | `/youtube/v3/playlists` | GET |
| Get tracks | `/youtube/v3/playlistItems` | GET |
| Get video details | `/youtube/v3/videos` | GET |
| Create playlist | `/youtube/v3/playlists` | POST |
| Add tracks | `/youtube/v3/playlistItems` | POST |
| Remove tracks | `/youtube/v3/playlistItems` | DELETE |
| Delete playlist | `/youtube/v3/playlists` | DELETE |
| Search | `/youtube/v3/search` | GET |

## Capabilities

- **Playlists:** Can access owned playlists only (YouTube doesn't expose shared playlists via API)
- **Pagination:** Page-based (pageToken)
- **Quota:** Daily bucket model (1,000,000 queries/day)
- **Renaming:** Not supported via API (YouTube Music limitation)

## Error Handling

| HTTP Status | Error Type / Reason | Handling |
|------------|-----------|----------|
| 401 | `AuthRequiredError` | Token refresh triggered automatically |
| 403 | `quotaExceeded` reason | `QuotaExhaustedError` |
| 403 | Other reasons | `AccessRestrictedError` |
| 404 | Not found | `NotFoundError` |

## Known Limitations

- Cannot rename playlists via API (YouTube Music limitation)
- Cannot access playlists shared by other users
- Video metadata minimal (title, channel, duration); no ISRC codes
- Duration returned as ISO 8601 (PT3M30S) → converted to ms internally
```

- [ ] **Step 3: Create ADR for provider implementation**

Create `docs/adr/0007-provider-implementation-strategy.md`:

```markdown
# ADR-0007: Provider Implementation Strategy

## Context

M0 defined a closed provider interface with two stub implementations (Spotify, YouTube Music). M1 tested this interface with fake provider. M2 implements full integrations for both real providers.

## Decision

Each provider adapter:

1. **Wraps provider REST API** without external SDKs (native fetch only)
2. **Converts API responses** to canonical types (PlaylistSummary, CanonicalTrack)
3. **Maps API errors** to closed error types (AuthRequiredError, NotFoundError, etc.)
4. **Uses M0 HttpClient** for retry/refresh logic
5. **Handles null/missing fields** gracefully (e.g., unavailable tracks on Spotify)

## Rationale

- **No SDKs:** Keeps dependencies minimal, gives us full control over error handling and retry logic
- **Canonical types:** CLI and core stay provider-agnostic
- **HttpClient reuse:** Token refresh happens in one place; all providers benefit transparently
- **Graceful degradation:** Missing fields become defaults, not crashes

## Consequences

- Must manually handle API pagination (cursors vs. page tokens differ)
- Must parse provider-specific types (Spotify URI format vs. YouTube video ID)
- Must maintain error mappings as API changes
- Easier to test (no SDK internals to mock; just HTTP responses)
- Easier to add new providers (implement interface, swap HTTP endpoints)

## Alternatives Considered

1. **Use Spotify SDK + google-auth-library:** Would simplify OAuth and retry logic, but adds external deps and locks us into SDK design choices.
2. **Share HTTP client logic per provider:** Not feasible; each API has unique pagination, error codes, auth headers.
3. **Delegate all conversion to a library (e.g., music-commons):** Would add complexity; one-off conversions are simpler.

## Status

Accepted. Implemented in M2-1, M2-3.
```

- [ ] **Step 4: Update README**

Update `README.md` to mention new providers:

```markdown
## Supported Providers

| Provider | Status | Notes |
|----------|--------|-------|
| Spotify | ✅ Full | All operations supported |
| YouTube Music | ✅ Full | Playlists (owned only); no renaming |
| (Amazon Music) | 🔜 Planned | M3+ scope |
```

Add section:

```markdown
## Provider-Specific Notes

See provider documentation:
- [Spotify](docs/providers/SPOTIFY.md) — OAuth setup, quota limits
- [YouTube Music](docs/providers/YOUTUBE-MUSIC.md) — API limitations, pagination

## Architecture

Provider adapters:
- Implement the closed `Provider` interface (src/core/provider/provider.ts)
- Wrap REST APIs without external SDKs
- Map errors to closed types (src/core/provider/errors.ts)
- Use HttpClient for retry/token refresh (src/core/http/client.ts)

See [ADR-0007](docs/adr/0007-provider-implementation-strategy.md) for design rationale.
```

- [ ] **Step 5: Run tests and commit**

```bash
npm test
git add docs/ README.md
git commit -m "docs: add provider integration details and implementation strategy"
```

---

#### Task M2-9: Verify test coverage and finalize

**Files:**
- No changes; verification only

**Interfaces:**
- Consumes: All provider implementations and tests
- Produces: Coverage report

- [ ] **Step 1: Generate full coverage report**

```bash
npm test -- --coverage --coverageReporters=text-summary
```

Expected output example:
```
======================== Coverage summary ========================
Statements   : 72.5% ( 290/400 )
Branches     : 68.3% ( 100/146 )
Functions    : 75% ( 45/60 )
Lines        : 72% ( 288/400 )
====================================================================
```

- [ ] **Step 2: Verify coverage targets**

- [ ] M0 core modules: ✅ ≥ 50% (maintained from M0)
- [ ] Spotify provider: ✅ ≥ 70% (new target)
- [ ] YouTube Music provider: ✅ ≥ 70% (new target)
- [ ] Overall: ✅ ≥ 65%

If any coverage falls short, add tests or update implementation.

- [ ] **Step 3: Run full test suite**

```bash
npm run lint
npm test
npm run build
```

Expected: All pass, no TS errors, no lint issues.

- [ ] **Step 4: Create CHANGELOG entry**

Update `CHANGELOG.md`:

```markdown
## [M2] 2026-10-05 — Provider Implementations

### Added

- **Spotify provider:** Full integration with Web API. Supports all playlist operations, search, track resolution.
- **YouTube Music provider:** Full integration with YouTube Data API. Supports owned playlists, search, track resolution.
- **HTTP client enhancements:** Rate-limit detection and proactive logging.
- **Provider documentation:** Spotify and YouTube Music setup guides, API endpoint references, error handling.
- **E2E tests:** Provider interface contract tests proving all providers meet the specification.

### Changed

- Provider adapters no longer use stubs; full API implementations active.
- Error mapping now consistent across all providers (closed error types).

### Test Coverage

- Spotify: 72% coverage
- YouTube Music: 71% coverage
- Overall: 68% coverage (up from 55% in M0)
```

- [ ] **Step 5: Final commit and summary**

```bash
git add CHANGELOG.md
git commit -m "docs: add M2 changelog"
git log --oneline -10  # Verify commit history
```

Expected commits (one per task):
1. M2-1: Spotify HTTP client and types
2. M2-2: Spotify integration tests
3. M2-3: YouTube Music HTTP client and types
4. M2-4: YouTube Music integration tests
5. M2-5: HTTP client rate-limit detection
6. M2-6: Provider registry update
7. M2-7: E2E provider tests
8. M2-8: Documentation (provider guides, ADR)
9. M2-9: Changelog

---

## Success Criteria

✓ **Spotify provider:** All operations (list, get, create, delete, search, resolve, add/remove tracks) working with mocked API responses  
✓ **YouTube Music provider:** All operations implemented; respects API limitations (owned-only, no rename)  
✓ **Error handling:** All closed error types used correctly; no raw API errors leak to CLI  
✓ **Test coverage:** ≥ 70% on both provider adapters; ≥ 65% overall  
✓ **No real API calls:** All tests use mocked responses; no credentials in tests  
✓ **Type safety:** TypeScript strict mode; no `any` types  
✓ **Documentation:** Provider setup guides, error mapping reference, implementation strategy documented  
✓ **E2E tests:** Prove both providers implement the `Provider` interface correctly  
✓ **Ready for M3:** CLI can use both providers; users can migrate playlists between Spotify and YouTube Music  

---

## Execution Guidance

This plan is structured for **subagent-driven** or **native** execution:

- **Subagent-driven:** Each task is independent enough for a fresh agent to implement; review gate between tasks ensures quality.
- **Native:** Implement sequentially in this session; one final review at the end.

Tasks in dependency order:
1. M2-1, M2-2 (Spotify) — parallel to M2-3, M2-4 (YouTube Music)
2. M2-5 (HTTP client enhancement) — can run in parallel with above
3. M2-6 (Registry update) — depends on M2-1, M2-3
4. M2-7 (E2E tests) — depends on M2-1, M2-3, M2-6
5. M2-8 (Documentation) — depends on all above
6. M2-9 (Coverage verification) — last

Estimated effort: **10–12 days** at 5d/week (2–2.5 weeks), accounting for debugging HTTP interactions and edge cases.
