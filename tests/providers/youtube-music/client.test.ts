import { test } from 'node:test'
import assert from 'node:assert/strict'
import { YouTubeMusicHttpClient } from '../../../src/providers/youtube-music/client.js'
import type { HttpClient } from '../../../src/core/http/client.js'

test('YouTubeMusicHttpClient', async (t) => {
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

  await t.test('listPlaylists', async (t) => {
    await t.test('should fetch user playlists with pagination', async () => {
      const mockHttp = createMockHttp()
      const client = new YouTubeMusicHttpClient(mockHttp)

      // Override requestJson to return test data
      let callCount = 0
      mockHttp.requestJson = async (opts, validator) => {
        callCount++
        const result = {
          items: [
            {
              id: 'pl1',
              snippet: {
                title: 'My Playlist',
                description: 'Test',
                channelTitle: 'Me',
                thumbnails: { high: { url: 'http://example.com/img.jpg' } }
              },
              contentDetails: { itemCount: 5 },
              status: { privacyStatus: 'private' }
            }
          ],
          pageInfo: { totalResults: 1, resultsPerPage: 1 },
          nextPageToken: undefined
        }
        return validator ? validator(result) : result
      }

      const result = await client.listPlaylists({ limit: 50 })
      assert.strictEqual(result.items.length, 1)
      assert.strictEqual(result.items[0].name, 'My Playlist')
      assert.strictEqual(result.items[0].trackCount, 5)
      assert.strictEqual(result.totalResults, 1)
    })
  })

  await t.test('duration parsing', async (t) => {
    await t.test('should parse ISO 8601 durations correctly', () => {
      const mockHttp = createMockHttp()
      const client = new YouTubeMusicHttpClient(mockHttp)
      const parsePrivate = (client as any).parseDuration.bind(client)

      assert.strictEqual(parsePrivate('PT3M30S'), 210000)
      assert.strictEqual(parsePrivate('PT1H2M3S'), 3723000)
      assert.strictEqual(parsePrivate('PT45S'), 45000)
      assert.strictEqual(parsePrivate(undefined), 0)
      assert.strictEqual(parsePrivate(''), 0)
    })
  })
})
