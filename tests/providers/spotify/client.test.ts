import { test } from 'node:test';
import * as assert from 'node:assert';
import { SpotifyHttpClient } from '../../../src/providers/spotify/client.js';
import {
  AuthRequiredError,
  AccessRestrictedError,
  NotFoundError,
  RateLimitError,
  QuotaExhaustedError,
  UsageError
} from '../../../src/core/provider/errors.js';
import { HttpClient } from '../../../src/core/http/client.js';

class MockHttpClient {
  async request(method: string, url: string, options?: any) {
    return this.mockResponse;
  }
  mockResponse = { status: 200, headers: new Map(), body: {} };
}

test('SpotifyHttpClient error mapping', async (t) => {
  await t.test('should throw AuthRequiredError on 401 Unauthorized', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = { status: 401, headers: new Map(), body: {} };
    const client = new SpotifyHttpClient(mockHttp as any);

    await assert.rejects(
      () => client.listPlaylists('user123'),
      AuthRequiredError
    );
  });

  await t.test('should throw AccessRestrictedError on 403 Forbidden', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = { status: 403, headers: new Map(), body: {} };
    const client = new SpotifyHttpClient(mockHttp as any);

    await assert.rejects(
      () => client.deletePlaylist('owned-by-other'),
      AccessRestrictedError
    );
  });

  await t.test('should throw NotFoundError on 404 Not Found', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = { status: 404, headers: new Map(), body: {} };
    const client = new SpotifyHttpClient(mockHttp as any);

    await assert.rejects(
      () => client.getPlaylist('invalid-id'),
      NotFoundError
    );
  });

  await t.test('should throw RateLimitError on 429 with Retry-After', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 429,
      headers: new Map([['retry-after', '60']]),
      body: {}
    };
    const client = new SpotifyHttpClient(mockHttp as any);

    await assert.rejects(
      () => client.listPlaylists('user123'),
      RateLimitError
    );
  });

  await t.test('should throw QuotaExhaustedError on 429 without Retry-After', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 429,
      headers: new Map(),
      body: { error: { status: 429, message: 'Quota exceeded' } }
    };
    const client = new SpotifyHttpClient(mockHttp as any);

    await assert.rejects(
      () => client.listPlaylists('user123'),
      QuotaExhaustedError
    );
  });

  await t.test('should handle null fields in track response gracefully', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 200,
      headers: new Map(),
      body: {
        items: [
          {
            track: null,  // Track is unavailable/removed
            added_at: '2024-01-01T00:00:00Z'
          }
        ],
        total: 1
      }
    };
    const client = new SpotifyHttpClient(mockHttp as any);

    const result = await client.getPlaylistTracks('playlist123');
    assert.strictEqual(result.tracks.length, 0);  // Skip null tracks
  });
});

test('SpotifyHttpClient operations', async (t) => {
  await t.test('listPlaylists should return paginated playlists', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 200,
      headers: new Map(),
      body: {
        items: [{
          id: 'test-playlist-1',
          name: 'Test Playlist',
          description: 'A test playlist',
          public: true,
          owner: { id: 'user123', display_name: 'Test User' },
          tracks: { total: 2 },
          images: [{ url: 'https://example.com/image.jpg' }],
          uri: 'spotify:playlist:test-playlist-1',
          external_urls: { spotify: '' }
        }],
        total: 1,
        next: null
      }
    };
    const client = new SpotifyHttpClient(mockHttp as any);

    const result = await client.listPlaylists('user123');
    assert.strictEqual(result.playlists.length, 1);
    assert.strictEqual(result.playlists[0].name, 'Test Playlist');
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.nextOffset, undefined);
  });

  await t.test('listPlaylists should include nextOffset when more results available', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 200,
      headers: new Map(),
      body: {
        items: [],
        total: 100,
        next: 'https://api.spotify.com/v1/users/user123/playlists?offset=50'
      }
    };
    const client = new SpotifyHttpClient(mockHttp as any);

    const result = await client.listPlaylists('user123', { limit: 50, offset: 0 });
    assert.strictEqual(result.nextOffset, 50);
  });

  await t.test('getPlaylistTracks should filter out null tracks', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 200,
      headers: new Map(),
      body: {
        items: [
          {
            track: {
              id: 'track-1',
              name: 'Song One',
              artists: [{ id: 'artist-1', name: 'Artist One' }],
              album: { id: 'album-1', name: 'Album One', release_date: '2024-01-01' },
              duration_ms: 180000,
              uri: 'spotify:track:track-1',
              external_urls: { spotify: '' }
            },
            added_at: '2024-01-01T12:00:00Z'
          },
          {
            track: null,  // Removed track
            added_at: '2024-01-02T12:00:00Z'
          },
          {
            track: {
              id: 'track-2',
              name: 'Song Two',
              artists: [{ id: 'artist-2', name: 'Artist Two' }],
              album: { id: 'album-2', name: 'Album Two', release_date: '2024-02-01' },
              duration_ms: 240000,
              uri: 'spotify:track:track-2',
              external_urls: { spotify: '' }
            },
            added_at: '2024-01-03T12:00:00Z'
          }
        ],
        total: 3,
        next: null
      }
    };
    const client = new SpotifyHttpClient(mockHttp as any);

    const result = await client.getPlaylistTracks('playlist-1');
    assert.strictEqual(result.tracks.length, 2);  // Null track filtered
    assert.strictEqual(result.tracks[0].title, 'Song One');
    assert.strictEqual(result.total, 3);  // Total reflects API response
  });

  await t.test('resolveTrack should return match candidates with confidence', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 200,
      headers: new Map(),
      body: {
        tracks: {
          items: [
            {
              id: 'track-1',
              name: 'Song One',
              artists: [{ id: 'artist-1', name: 'Artist One' }],
              album: { id: 'album-1', name: 'Album One', release_date: '2024-01-01' },
              duration_ms: 180000,
              uri: 'spotify:track:track-1',
              external_urls: { spotify: '' }
            },
            {
              id: 'track-2',
              name: 'Different Song',
              artists: [{ id: 'artist-2', name: 'Different Artist' }],
              album: { id: 'album-2', name: 'Album Two', release_date: '2024-02-01' },
              duration_ms: 240000,
              uri: 'spotify:track:track-2',
              external_urls: { spotify: '' }
            }
          ],
          total: 2,
          next: null
        }
      }
    };
    const client = new SpotifyHttpClient(mockHttp as any);

    const result = await client.resolveTrack('Song One', ['Artist One']);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].trackRef, 'spotify:track:track-1');
    assert.ok(result[0].confidence > 0);
  });

  await t.test('searchTracks should return empty array on no results', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 200,
      headers: new Map(),
      body: {
        tracks: {
          items: [],
          total: 0,
          next: null
        }
      }
    };
    const client = new SpotifyHttpClient(mockHttp as any);

    const result = await client.searchTracks('Nonexistent Song');
    assert.strictEqual(result.tracks.length, 0);
  });

  await t.test('addTracksToPlaylist should split large requests into batches', async () => {
    const calls: Array<{ uris: string[] }> = [];
    const mockHttp = new MockHttpClient();
    let callCount = 0;
    mockHttp.request = async (method: string, url: string, options?: any) => {
      if (options?.body) {
        calls.push(JSON.parse(options.body));
      }
      callCount++;
      return { status: 200, headers: new Map(), body: {} };
    };
    const client = new SpotifyHttpClient(mockHttp as any);

    const tracks = Array.from({ length: 250 }, (_, i) => `spotify:track:${i}`);
    await client.addTracksToPlaylist('playlist-1', tracks);

    assert.strictEqual(callCount, 3);  // 250 tracks = 3 batches (100 + 100 + 50)
  });
});
