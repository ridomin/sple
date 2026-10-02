import { test, beforeEach, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { mapSpotifySearchResults } from '../../../src/providers/spotify/mappers.js'

const realFetch = globalThis.fetch

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

type Responder = (call: Call) => Response | Promise<Response>

let calls: Call[]

function mockFetch(routes: Record<string, Responder>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const route = routes[url]
    if (!route) throw new Error(`Unexpected fetch: ${url}`)
    return route(call)
  }) as typeof fetch
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

beforeEach(() => {
  calls = []
})

afterEach(() => {
  globalThis.fetch = realFetch
})

test('mapSpotifySearchResults', async (t) => {
  await t.test('maps track search results correctly', () => {
    const mockSearchResponse = {
      tracks: {
        items: [
          {
            id: 'track1',
            name: 'Song 1',
            uri: 'spotify:track:track1',
            type: 'track',
            artists: [{ name: 'Artist 1' }],
            duration_ms: 180000,
          },
          {
            id: 'track2',
            name: 'Song 2',
            uri: 'spotify:track:track2',
            type: 'track',
            artists: [{ name: 'Artist 2' }],
            duration_ms: 200000,
          },
        ],
      },
    }

    const result = mapSpotifySearchResults(mockSearchResponse)

    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].name, 'Song 1')
    assert.strictEqual(result[0].type, 'track')
    assert.strictEqual(result[0].id, 'track1')
    assert.strictEqual(result[0].ref, 'spotify:track:track1')
    assert.ok(result[0].url?.includes('open.spotify.com/track/track1'))
  })

test('search handles multiple result types', async (t) => {
  await t.test('maps mixed track, album, artist, and playlist results', async () => {
    const mockSearchResponse = {
      tracks: {
        items: [
          {
            id: 'track1',
            name: 'Song 1',
            uri: 'spotify:track:track1',
            type: 'track',
            artists: [{ name: 'Artist 1' }],
            duration_ms: 180000,
          },
        ],
      },
      albums: {
        items: [
          {
            id: 'album1',
            name: 'Album 1',
            uri: 'spotify:album:album1',
            type: 'album',
            artists: [{ name: 'Artist 1' }],
            release_date: '2020-01-01',
            total_tracks: 10,
          },
        ],
      },
      artists: {
        items: [
          {
            id: 'artist1',
            name: 'Artist 1',
            uri: 'spotify:artist:artist1',
            type: 'artist',
          },
        ],
      },
      playlists: {
        items: [
          {
            id: 'playlist1',
            name: 'Playlist 1',
            uri: 'spotify:playlist:playlist1',
            type: 'playlist',
            owner: { id: 'user123', display_name: 'Owner' },
            tracks: { total: 50 },
          },
        ],
      },
    }

    mockFetch({
      'https://api.spotify.com/v1/search?q=test&type=track%2Calbum%2Cartist%2Cplaylist&limit=10&offset=0': () =>
        json(200, mockSearchResponse),
    })

    const provider = createSpotifyProvider('client-id')

    const originalModule = await import('../../../src/core/config/token-store.js')
    const originalLoadTokens = originalModule.loadTokens
    ;(await import('../../../src/core/config/token-store.js')).loadTokens = () => tokenStored()

    try {
      const result = await provider.search({ text: 'test', type: 'track,album,artist,playlist' }, { limit: 10 })

      assert.strictEqual(result.items.length, 4)

      // Check track
      const track = result.items.find((i) => i.type === 'track')
      assert.ok(track)
      assert.strictEqual(track?.name, 'Song 1')

      // Check album
      const album = result.items.find((i) => i.type === 'album')
      assert.ok(album)
      assert.strictEqual(album?.name, 'Album 1')
      assert.strictEqual(album?.releaseDate, '2020-01-01')

      // Check artist
      const artist = result.items.find((i) => i.type === 'artist')
      assert.ok(artist)
      assert.strictEqual(artist?.name, 'Artist 1')

      // Check playlist
      const playlist = result.items.find((i) => i.type === 'playlist')
      assert.ok(playlist)
      assert.strictEqual(playlist?.name, 'Playlist 1')
      assert.strictEqual(playlist?.trackCount, 50)
    } finally {
      ;(await import('../../../src/core/config/token-store.js')).loadTokens = originalLoadTokens
    }
  })
})

test('search respects maxSearchPageSize', async (t) => {
  await t.test('limits page size to maxSearchPageSize even if requested larger', async () => {
    const mockSearchResponse = {
      tracks: {
        items: Array.from({ length: 10 }, (_, i) => ({
          id: `track${i}`,
          name: `Song ${i}`,
          uri: `spotify:track:track${i}`,
          type: 'track',
          artists: [{ name: `Artist ${i}` }],
        })),
        total: 50,
        offset: 0,
        limit: 10,
      },
    }

    mockFetch({
      'https://api.spotify.com/v1/search?q=test&type=track&limit=10&offset=0': () =>
        json(200, mockSearchResponse),
    })

    const provider = createSpotifyProvider('client-id')

    const originalModule = await import('../../../src/core/config/token-store.js')
    const originalLoadTokens = originalModule.loadTokens
    ;(await import('../../../src/core/config/token-store.js')).loadTokens = () => tokenStored()

    try {
      // Request limit of 50, but should be capped at maxSearchPageSize (10)
      const result = await provider.search({ text: 'test', type: 'track' }, { limit: 50 })

      assert.strictEqual(result.items.length, 10)
      // Verify the API was called with limit=10, not 50
      const searchCall = calls.find((c) => c.url.includes('/search'))
      assert.ok(searchCall)
      assert.ok(searchCall.url.includes('limit=10'))
    } finally {
      ;(await import('../../../src/core/config/token-store.js')).loadTokens = originalLoadTokens
    }
  })
})

test('search handles offset parameter', async (t) => {
  await t.test('supports offset parameter for pagination', async () => {
    const mockSearchResponse = {
      tracks: {
        items: Array.from({ length: 10 }, (_, i) => ({
          id: `track${i + 10}`,
          name: `Song ${i + 10}`,
          uri: `spotify:track:track${i + 10}`,
          type: 'track',
          artists: [{ name: `Artist ${i}` }],
        })),
        total: 50,
        offset: 10,
        limit: 10,
      },
    }

    mockFetch({
      'https://api.spotify.com/v1/search?q=test&type=track&limit=10&offset=10': () =>
        json(200, mockSearchResponse),
    })

    const provider = createSpotifyProvider('client-id')

    const originalModule = await import('../../../src/core/config/token-store.js')
    const originalLoadTokens = originalModule.loadTokens
    ;(await import('../../../src/core/config/token-store.js')).loadTokens = () => tokenStored()

    try {
      const result = await provider.search({ text: 'test', type: 'track' }, { limit: 10, offset: 10 })

      assert.strictEqual(result.items.length, 10)
      assert.strictEqual(result.items[0].id, 'track10')

      // Verify the API was called with correct offset
      const searchCall = calls.find((c) => c.url.includes('/search'))
      assert.ok(searchCall)
      assert.ok(searchCall.url.includes('offset=10'))
    } finally {
      ;(await import('../../../src/core/config/token-store.js')).loadTokens = originalLoadTokens
    }
  })
})

test('search handles empty results gracefully', async (t) => {
  await t.test('returns empty items array when no results', async () => {
    const mockSearchResponse = {
      tracks: {
        items: [],
        total: 0,
        offset: 0,
        limit: 10,
      },
    }

    mockFetch({
      'https://api.spotify.com/v1/search?q=nonexistent&type=track&limit=10&offset=0': () =>
        json(200, mockSearchResponse),
    })

    const provider = createSpotifyProvider('client-id')

    const originalModule = await import('../../../src/core/config/token-store.js')
    const originalLoadTokens = originalModule.loadTokens
    ;(await import('../../../src/core/config/token-store.js')).loadTokens = () => tokenStored()

    try {
      const result = await provider.search({ text: 'nonexistent', type: 'track' }, { limit: 10 })

      assert.strictEqual(result.items.length, 0)
      assert.ok(!result.next)
    } finally {
      ;(await import('../../../src/core/config/token-store.js')).loadTokens = originalLoadTokens
    }
  })
})

test('search URL encodes query parameters', async (t) => {
  await t.test('properly encodes special characters in search query', async () => {
    const mockSearchResponse = {
      tracks: {
        items: [],
        total: 0,
      },
    }

    const expectedUrl =
      'https://api.spotify.com/v1/search?q=test%20query%20with%20spaces&type=track&limit=10&offset=0'

    mockFetch({
      [expectedUrl]: () => json(200, mockSearchResponse),
    })

    const provider = createSpotifyProvider('client-id')

    const originalModule = await import('../../../src/core/config/token-store.js')
    const originalLoadTokens = originalModule.loadTokens
    ;(await import('../../../src/core/config/token-store.js')).loadTokens = () => tokenStored()

    try {
      await provider.search({ text: 'test query with spaces', type: 'track' }, { limit: 10 })

      const searchCall = calls.find((c) => c.url.includes('/search'))
      assert.ok(searchCall)
      assert.ok(searchCall.url.includes('test%20query%20with%20spaces'))
    } finally {
      ;(await import('../../../src/core/config/token-store.js')).loadTokens = originalLoadTokens
    }
  })
})
