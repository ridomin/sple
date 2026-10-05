import { test } from 'node:test';
import * as assert from 'node:assert';
import { YouTubeMusicHttpClient } from '../../../src/providers/youtube-music/client.js';
import {
  AuthRequiredError,
  AccessRestrictedError,
  NotFoundError,
  RateLimitError,
  QuotaExhaustedError,
  UsageError
} from '../../../src/core/provider/errors.js';

class MockHttpClient {
  async request(method: string, url: string, options?: any) {
    return this.mockResponse;
  }
  mockResponse = { status: 200, headers: new Map(), body: {} };
}

test('YouTubeMusicHttpClient error mapping', async (t) => {
  await t.test('should throw AuthRequiredError on 401', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = { status: 401, headers: new Map(), body: {} };
    const client = new YouTubeMusicHttpClient(mockHttp as any);

    await assert.rejects(() => client.listPlaylists(), AuthRequiredError);
  });

  await t.test('should throw QuotaExhaustedError on 403 quotaExceeded', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 403,
      headers: new Map(),
      body: { error: { errors: [{ reason: 'quotaExceeded' }] } }
    };
    const client = new YouTubeMusicHttpClient(mockHttp as any);

    await assert.rejects(() => client.listPlaylists(), QuotaExhaustedError);
  });

  await t.test('should throw AccessRestrictedError on 403 other', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 403,
      headers: new Map(),
      body: { error: { errors: [{ reason: 'forbidden' }] } }
    };
    const client = new YouTubeMusicHttpClient(mockHttp as any);

    await assert.rejects(() => client.listPlaylists(), AccessRestrictedError);
  });

  await t.test('should throw NotFoundError on 404', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = { status: 404, headers: new Map(), body: {} };
    const client = new YouTubeMusicHttpClient(mockHttp as any);

    await assert.rejects(() => client.getPlaylist('invalid'), NotFoundError);
  });

  await t.test('should handle null/missing fields gracefully', async () => {
    const mockHttp = new MockHttpClient();
    let callCount = 0;
    mockHttp.request = async (method: string, url: string, options?: any) => {
      callCount++;
      if (callCount === 1) {
        // First call: search
        return {
          status: 200,
          headers: new Map(),
          body: {
            items: [{
              id: { videoId: 'video-1' },
              snippet: {
                title: 'Song',
                description: '',
                channelTitle: 'Artist'
              }
            }],
            pageInfo: { totalResults: 1, resultsPerPage: 1 }
          }
        };
      }
      // Second call: videos
      return {
        status: 200,
        headers: new Map(),
        body: {
          items: [{
            id: 'video-1',
            snippet: {
              title: 'Song',
              description: '',
              channelTitle: 'Artist',
              publishedAt: '2024-01-01T00:00:00Z'
            }
            // no contentDetails (duration missing)
          }],
          pageInfo: { totalResults: 1, resultsPerPage: 1 }
        }
      };
    };
    const client = new YouTubeMusicHttpClient(mockHttp as any);

    const result = await client.searchTracks('Song');
    assert.strictEqual(result.tracks.length, 1);
    assert.strictEqual(result.tracks[0].duration, 0);  // Default to 0 if missing
  });
});

test('YouTubeMusicHttpClient operations', async (t) => {
  await t.test('listPlaylists should return paginated playlists with pageToken', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 200,
      headers: new Map(),
      body: {
        items: [{
          id: 'pl-1',
          snippet: { title: 'Playlist 1', description: '', channelTitle: 'Me' },
          contentDetails: { itemCount: 5 },
          status: { privacyStatus: 'private' }
        }],
        pageInfo: { totalResults: 100, resultsPerPage: 1 },
        nextPageToken: 'NEXT_PAGE'
      }
    };
    const client = new YouTubeMusicHttpClient(mockHttp as any, 'key');

    const result = await client.listPlaylists();
    assert.strictEqual(result.playlists.length, 1);
    assert.strictEqual(result.nextPageToken, 'NEXT_PAGE');
  });

  await t.test('getPlaylist should throw NotFoundError if not found', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 200,
      headers: new Map(),
      body: { items: [], pageInfo: { totalResults: 0 } }
    };
    const client = new YouTubeMusicHttpClient(mockHttp as any);

    await assert.rejects(() => client.getPlaylist('invalid'), NotFoundError);
  });

  await t.test('parseDuration should handle ISO 8601 format', async () => {
    const mockHttp = new MockHttpClient();
    let callCount = 0;
    mockHttp.request = async (method: string, url: string, options?: any) => {
      callCount++;
      if (callCount === 1) {
        // First call: search
        return {
          status: 200,
          headers: new Map(),
          body: {
            items: [{
              id: { videoId: 'vid-1' },
              snippet: { title: 'Song', description: '', channelTitle: 'Artist' }
            }],
            pageInfo: { totalResults: 1, resultsPerPage: 1 }
          }
        };
      }
      // Second call: videos
      return {
        status: 200,
        headers: new Map(),
        body: {
          items: [{
            id: 'vid-1',
            snippet: {
              title: 'Song',
              description: '',
              channelTitle: 'Artist',
              publishedAt: '2024-01-01T00:00:00Z'
            },
            contentDetails: { duration: 'PT3M30S' }  // 3 minutes 30 seconds
          }],
          pageInfo: { totalResults: 1, resultsPerPage: 1 }
        }
      };
    };
    const client = new YouTubeMusicHttpClient(mockHttp as any);

    const result = await client.searchTracks('test');
    assert.strictEqual(result.tracks[0].duration, 210000);  // 3*60 + 30 = 210 seconds in ms
  });

  await t.test('resolveTrack should filter out zero-confidence matches', async () => {
    const mockHttp = new MockHttpClient();
    mockHttp.mockResponse = {
      status: 200,
      headers: new Map(),
      body: {
        items: [{
          id: { videoId: 'vid-1' },
          snippet: { title: 'Unrelated', description: '', channelTitle: 'Other' }
        }],
        pageInfo: { totalResults: 1 }
      }
    };
    mockHttp.request = async (method: string, url: string, options?: any) => {
      // First call: search
      if (url.includes('/search')) {
        return {
          status: 200,
          headers: new Map(),
          body: {
            items: [{
              id: { videoId: 'vid-1' },
              snippet: { title: 'Unrelated Song', description: '', channelTitle: 'Other Artist' }
            }],
            pageInfo: { totalResults: 1 }
          }
        };
      }
      // Second call: videos
      return {
        status: 200,
        headers: new Map(),
        body: {
          items: [{
            id: 'vid-1',
            snippet: { title: 'Unrelated Song', description: '', channelTitle: 'Other Artist', publishedAt: '' }
          }],
          pageInfo: { totalResults: 1 }
        }
      };
    };
    const client = new YouTubeMusicHttpClient(mockHttp as any);

    const result = await client.resolveTrack('Query Song', ['Query Artist']);
    assert.strictEqual(result.length, 0);  // No matching confidence
  });
});
