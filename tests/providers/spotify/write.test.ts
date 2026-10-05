import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import createDebug from 'debug'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'
import { saveTokens, type StoredToken } from '../../../src/core/config/token-store.js'
import {
  AccessRestrictedError,
  AuthRequiredError,
  UsageError,
} from '../../../src/core/provider/errors.js'

const ACCESS = 'BQD-access-token'
const REFRESH = 'AQA-refresh-token'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

type Responder = (call: Call) => Response | Promise<Response>

const realFetch = globalThis.fetch
let calls: Call[]
let tempDir: string
let debugOutput: string[]
const realDebugLog = createDebug.log

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

test('Spotify write operations (M1-21)', async (t) => {
  t.before(() => {
    tempDir = mkdtempSync(`${tmpdir()}/sple-test-`)
    debugOutput = []
    createDebug.log = (msg: string) => {
      debugOutput.push(msg)
    }
  })

  t.after(() => {
    globalThis.fetch = realFetch
    createDebug.log = realDebugLog
    rmSync(tempDir, { recursive: true, force: true })
  })

  await t.test('createPlaylist with public visibility', async () => {
    calls = []
    const token: StoredToken = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ['playlist-modify-public', 'playlist-modify-private'],
      userId: 'user123',
      displayName: 'Test User',
      grantedAt: new Date().toISOString(),
    }
    saveTokens('spotify', token, tempDir)

    mockFetch({
      'https://api.spotify.com/v1/me/playlists': () =>
        json(201, {
          id: 'pl123',
          name: 'My Public Playlist',
          description: 'A test playlist',
          owner: { id: 'user123', display_name: 'Test User' },
          public: true,
          collaborative: false,
          uri: 'spotify:playlist:pl123',
        }),
    })

    const provider = createSpotifyProvider('test-client', tempDir)
    const result = await provider.createPlaylist({
      name: 'My Public Playlist',
      description: 'A test playlist',
      public: true,
    })

    assert.strictEqual(result.id, 'pl123')
    assert.strictEqual(result.name, 'My Public Playlist')
    assert.strictEqual(result.public, true)
    assert.strictEqual(result.owned, true)

    // Verify scope check ran first
    assert.strictEqual(calls.length, 1)
    const call = calls[0]
    assert.strictEqual(call.method, 'POST')
    assert.ok(call.url.includes('/me/playlists'))
    assert.ok(call.headers.authorization?.includes('Bearer'))
  })

  await t.test('createPlaylist with private visibility', async () => {
    calls = []
    const token: StoredToken = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ['playlist-modify-private'],
      userId: 'user456',
      displayName: 'Another User',
      grantedAt: new Date().toISOString(),
    }
    saveTokens('spotify', token, tempDir)

    mockFetch({
      'https://api.spotify.com/v1/me/playlists': () =>
        json(201, {
          id: 'pl456',
          name: 'My Private Playlist',
          owner: { id: 'user456', display_name: 'Another User' },
          public: false,
          collaborative: false,
          uri: 'spotify:playlist:pl456',
        }),
    })

    const provider = createSpotifyProvider('test-client', tempDir)
    const result = await provider.createPlaylist({
      name: 'My Private Playlist',
      public: false,
    })

    assert.strictEqual(result.id, 'pl456')
    assert.strictEqual(result.public, false)
  })

  await t.test('createPlaylist with collaborative visibility', async () => {
    calls = []
    const token: StoredToken = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ['playlist-modify-public', 'playlist-modify-private'],
      userId: 'user789',
      displayName: 'Collab User',
      grantedAt: new Date().toISOString(),
    }
    saveTokens('spotify', token, tempDir)

    mockFetch({
      'https://api.spotify.com/v1/me/playlists': () =>
        json(201, {
          id: 'pl789',
          name: 'Collaborative Playlist',
          owner: { id: 'user789', display_name: 'Collab User' },
          public: false,
          collaborative: true,
          uri: 'spotify:playlist:pl789',
        }),
    })

    const provider = createSpotifyProvider('test-client', tempDir)
    const result = await provider.createPlaylist({
      name: 'Collaborative Playlist',
      public: false,
      collaborative: true,
    })

    assert.strictEqual(result.id, 'pl789')
    assert.strictEqual(result.collaborative, true)
  })

  await t.test('createPlaylist rejects collaborative + public before API call', async () => {
    calls = []
    const token: StoredToken = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ['playlist-modify-public', 'playlist-modify-private'],
      userId: 'user999',
      displayName: 'Test',
      grantedAt: new Date().toISOString(),
    }
    saveTokens('spotify', token, tempDir)

    mockFetch({})

    const provider = createSpotifyProvider('test-client', tempDir)

    try {
      await provider.createPlaylist({
        name: 'Invalid Playlist',
        public: true,
        collaborative: true,
      })
      assert.fail('Should have thrown UsageError')
    } catch (error) {
      assert.ok(error instanceof UsageError)
      assert.ok((error as Error).message.includes('public collaborative'))
    }

    // Verify no API call was made
    assert.strictEqual(calls.length, 0)
  })

  await t.test('removePlaylist returns unfollowed', async () => {
    calls = []
    const token: StoredToken = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ['playlist-modify-public', 'playlist-modify-private'],
      userId: 'user123',
      displayName: 'Test User',
      grantedAt: new Date().toISOString(),
    }
    saveTokens('spotify', token, tempDir)

    mockFetch({
      'https://api.spotify.com/v1/me/library?uris=spotify%3Aplaylist%3A00000000000000000pl123': () => json(200, {}),
    })

    const provider = createSpotifyProvider('test-client', tempDir)
    const result = await provider.removePlaylist('00000000000000000pl123')

    assert.strictEqual(result.action, 'unfollowed')

    // Verify scope check ran and API call was made
    assert.strictEqual(calls.length, 1)
    const call = calls[0]
    assert.strictEqual(call.method, 'DELETE')
    assert.ok(call.url.includes('/me/library'))
    assert.ok(call.url.includes('uris=') && call.url.includes('pl123'))
  })

  await t.test('removePlaylist maps 403 to AccessRestrictedError', async () => {
    calls = []
    const token: StoredToken = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ['playlist-modify-public', 'playlist-modify-private'],
      userId: 'user123',
      displayName: 'Test User',
      grantedAt: new Date().toISOString(),
    }
    saveTokens('spotify', token, tempDir)

    mockFetch({
      'https://api.spotify.com/v1/me/library?uris=spotify%3Aplaylist%3A00000000000000000pl999': () =>
        json(403, { error: { message: 'Forbidden' } }),
    })

    const provider = createSpotifyProvider('test-client', tempDir)

    try {
      await provider.removePlaylist('00000000000000000pl999')
      assert.fail('Should have thrown AccessRestrictedError')
    } catch (error) {
      assert.ok(error instanceof AccessRestrictedError)
    }
  })

  await t.test('createPlaylist checks scopes before API call', async () => {
    calls = []
    const token: StoredToken = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ['playlist-read-private'], // Missing playlist-modify-private
      userId: 'user123',
      displayName: 'Test User',
      grantedAt: new Date().toISOString(),
    }
    saveTokens('spotify', token, tempDir)

    mockFetch({})

    const provider = createSpotifyProvider('test-client', tempDir)

    try {
      await provider.createPlaylist({
        name: 'Playlist',
        public: false,
      })
      assert.fail('Should have thrown AuthRequiredError')
    } catch (error) {
      assert.ok(error instanceof AuthRequiredError)
      assert.strictEqual((error as AuthRequiredError).reason, 'missing-scope')
    }

    // Verify no API call was made (scope check should fail first)
    assert.strictEqual(calls.length, 0)
  })

  await t.test('resolveTrack throws UsageError with release message', async () => {
    const provider = createSpotifyProvider('test-client', tempDir)

    try {
      await provider.resolveTrack(
        {
          title: 'Song',
          artists: ['Artist'],
          refs: { spotify: 'spotify:track:123' },
          isrc: null,
        },
        { maxCandidates: 5 }
      )
      assert.fail('Should have thrown UsageError')
    } catch (error) {
      assert.ok(error instanceof UsageError)
      assert.ok((error as Error).message.includes('not available'))
    }
  })

  await t.test('populatePlaylist throws UsageError with release message', async () => {
    const provider = createSpotifyProvider('test-client', tempDir)

    try {
      await provider.populatePlaylist('pl123', ['spotify:track:1'], { skipExisting: false })
      assert.fail('Should have thrown UsageError')
    } catch (error) {
      assert.ok(error instanceof UsageError)
      assert.ok((error as Error).message.includes('not available'))
    }
  })

  await t.test('createPlaylist includes url in summary', async () => {
    calls = []
    const token: StoredToken = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ['playlist-modify-public', 'playlist-modify-private'],
      userId: 'user123',
      displayName: 'Test User',
      grantedAt: new Date().toISOString(),
    }
    saveTokens('spotify', token, tempDir)

    mockFetch({
      'https://api.spotify.com/v1/me/playlists': () =>
        json(201, {
          id: 'pl-with-url',
          name: 'URL Test Playlist',
          owner: { id: 'user123', display_name: 'Test User' },
          public: true,
          collaborative: false,
          uri: 'spotify:playlist:pl-with-url',
        }),
    })

    const provider = createSpotifyProvider('test-client', tempDir)
    const result = await provider.createPlaylist({
      name: 'URL Test Playlist',
      public: true,
    })

    assert.ok(result.url)
    assert.ok(result.url.includes('https://open.spotify.com/playlist/'))
    assert.ok(result.url.includes('pl-with-url'))
  })
})
