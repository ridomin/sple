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
