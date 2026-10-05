import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpotifyHttpClient } from '../../../src/providers/spotify/client.js'
import type { HttpClient } from '../../../src/core/http/client.js'

test('SpotifyHttpClient', async (t) => {
  function createMockHttp(): HttpClient {
    const mockData: Record<string, unknown> = {}
    return {
      requestJson: async (opts, validator) => {
        const result = mockData[JSON.stringify(opts)] || {}
        return validator ? validator(result) : result
      },
      request: async (opts) => {
        mockData[JSON.stringify(opts)] = true
        return undefined
      },
    } as HttpClient
  }

  await t.test('getPlaylist', async (t) => {
    await t.test('should parse spotify:playlist: URI and fetch playlist', async () => {
      const mockHttp = createMockHttp()
      const client = new SpotifyHttpClient(mockHttp)

      mockHttp.requestJson = async (opts, validator) => {
        const result = {
          id: 'pl1',
          uri: 'spotify:playlist:pl1',
          name: 'My Playlist',
          description: 'Test playlist',
          owner: { id: 'user1', display_name: 'User' },
          public: true,
          tracks: { total: 2 },
          external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' }
        }
        return validator ? validator(result) : result
      }

      const result = await client.getPlaylist('spotify:playlist:pl1')
      assert.strictEqual(result.name, 'My Playlist')
      assert.strictEqual(result.trackCount, 2)
      assert.strictEqual(result.ref, 'spotify:playlist:pl1')
    })
  })

  await t.test('getPlaylistTracks', async (t) => {
    await t.test('should filter out null (unavailable) tracks', async () => {
      const mockHttp = createMockHttp()
      const client = new SpotifyHttpClient(mockHttp)

      mockHttp.requestJson = async (opts, validator) => {
        const result = {
          items: [
            { track: { id: 't1', name: 'Song 1', uri: 'spotify:track:t1', artists: [{ name: 'Artist' }], album: { name: 'Album', id: 'a1' }, duration_ms: 180000 }, added_at: '2024-01-01T00:00:00Z' },
            { track: null, added_at: '2024-01-02T00:00:00Z' },
            { track: { id: 't2', name: 'Song 2', uri: 'spotify:track:t2', artists: [{ name: 'Artist' }], album: { name: 'Album', id: 'a1' }, duration_ms: 200000 }, added_at: '2024-01-03T00:00:00Z' }
          ],
          total: 3,
          next: null
        }
        return validator ? validator(result) : result
      }

      const result = await client.getPlaylistTracks('spotify:playlist:pl1')
      assert.strictEqual(result.length, 2)
      assert.strictEqual(result[0].title, 'Song 1')
      assert.strictEqual(result[1].title, 'Song 2')
    })
  })

  await t.test('searchTracks', async (t) => {
    await t.test('should return tracks from search results', async () => {
      const mockHttp = createMockHttp()
      const client = new SpotifyHttpClient(mockHttp)

      mockHttp.requestJson = async (opts, validator) => {
        const result = {
          tracks: {
            items: [
              { id: 't1', name: 'Song', uri: 'spotify:track:t1', artists: [{ name: 'Artist' }], album: { name: 'Album', id: 'a1' }, duration_ms: 180000 }
            ],
            total: 1,
            next: null
          }
        }
        return validator ? validator(result) : result
      }

      const result = await client.searchTracks({ text: 'song query' })
      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].title, 'Song')
    })
  })

  await t.test('createPlaylist', async (t) => {
    await t.test('should fetch current user and create playlist', async () => {
      const mockHttp = createMockHttp()
      const client = new SpotifyHttpClient(mockHttp)

      let requestCount = 0
      mockHttp.requestJson = async (opts, validator) => {
        requestCount++
        let result
        if (requestCount === 1) {
          result = { id: 'user1', display_name: 'Test User' }
        } else {
          result = {
            id: 'new-pl',
            uri: 'spotify:playlist:new-pl',
            name: 'New Playlist',
            description: 'Created playlist',
            owner: { id: 'user1', display_name: 'Test User' },
            public: true,
            tracks: { total: 0 },
            external_urls: { spotify: 'https://open.spotify.com/playlist/new-pl' }
          }
        }
        return validator ? validator(result) : result
      }

      const result = await client.createPlaylist({
        name: 'New Playlist',
        description: 'Created playlist',
        public: true
      })

      assert.strictEqual(result.name, 'New Playlist')
      assert.strictEqual(result.trackCount, 0)
    })
  })

  await t.test('getLikedTracks', async (t) => {
    await t.test('should fetch saved tracks (liked songs)', async () => {
      const mockHttp = createMockHttp()
      const client = new SpotifyHttpClient(mockHttp)

      mockHttp.requestJson = async (opts, validator) => {
        const result = {
          items: [
            { track: { id: 't1', name: 'Liked Song', uri: 'spotify:track:t1', artists: [{ name: 'Artist' }], album: { name: 'Album', id: 'a1' }, duration_ms: 180000 }, added_at: '2024-01-01T00:00:00Z' }
          ],
          total: 1,
          next: null
        }
        return validator ? validator(result) : result
      }

      const result = await client.getLikedTracks({ limit: 50 })
      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].title, 'Liked Song')
    })
  })
})
