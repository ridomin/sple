/**
 * The Spotify adapter routes every /v1 call through the shared HttpClient
 * (M1-12, PRV-4): token refresh (proactive, reactive, single-flight),
 * Retry-After-aware 429 retries, boundary validation, and --debug lines.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupLogging } from '../../../src/cli/log.js'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'
import { saveTokens, loadTokens, type StoredToken } from '../../../src/core/config/token-store.js'
import { AuthRequiredError, ProviderError, RateLimitError } from '../../../src/core/provider/errors.js'
import { getExitCode, EXIT_CODES } from '../../../src/cli/exit-codes.js'

const API = 'https://api.spotify.com/v1'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const ME = 'testuser0000000000000'
const PL = '0FRr10mglUR3E0Pq8TqlxL'

interface Call {
  url: string
  method: string
  auth?: string
  body?: string
}

const realFetch = globalThis.fetch
let calls: Call[]
let dir: string

type Route = (call: Call) => Response | Promise<Response>

function mockFetch(route: Route) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      auth: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    return route(call)
  }) as typeof fetch
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

function storeToken(overrides: Partial<StoredToken> = {}): void {
  saveTokens(
    'spotify',
    {
      accessToken: 'old-access',
      refreshToken: 'the-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read'],
      userId: ME,
      displayName: 'Me',
      grantedAt: '2026-10-01T00:00:00.000Z',
      ...overrides,
    },
    dir
  )
}

const expired = () => ({ expiresAt: new Date(Date.now() - 3600_000).toISOString() })

function playlist() {
  return {
    id: PL,
    name: 'Mine',
    owner: { id: ME, display_name: 'Me' },
    public: false,
    collaborative: false,
    items: { total: 250 },
  }
}

function track(n: number) {
  return {
    added_at: '2026-01-01T00:00:00Z',
    is_local: false,
    item: {
      type: 'track',
      id: `t${n}`,
      name: `Track ${n}`,
      uri: `spotify:track:t${n}`,
      artists: [{ name: 'A' }],
      duration_ms: 1000,
    },
  }
}

function itemsPage(offset: number, total: number) {
  const count = Math.max(0, Math.min(100, total - offset))
  return { items: Array.from({ length: count }, (_, i) => track(offset + i)), total, offset, limit: 100 }
}

function tokenResponse() {
  return json(200, { access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 })
}

beforeEach(() => {
  calls = []
  dir = mkdtempSync(join(tmpdir(), 'sple-spotify-http-'))
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
})

test('expired token: one refresh, then the call succeeds with the new token, which is saved', async () => {
  storeToken(expired())
  mockFetch((c) => {
    if (c.url === TOKEN_URL) return tokenResponse()
    if (c.url === `${API}/playlists/${PL}`) {
      return c.auth === 'Bearer new-access' ? json(200, playlist()) : json(401, { error: { status: 401 } })
    }
    throw new Error(`Unexpected fetch: ${c.url}`)
  })

  const summary = await createSpotifyProvider('cid', dir).getPlaylist(PL)

  assert.equal(summary.name, 'Mine')
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1)
  assert.deepEqual(
    calls.filter((c) => c.url !== TOKEN_URL).map((c) => c.auth),
    ['Bearer new-access']
  )
  const saved = loadTokens('spotify', dir)
  assert.equal(saved?.accessToken, 'new-access')
  assert.equal(saved?.refreshToken, 'the-refresh', 'refresh token kept when not rotated')
})

test('expired token under concurrent paging: exactly one refresh (single-flight)', async () => {
  storeToken(expired())
  mockFetch(async (c) => {
    if (c.url === TOKEN_URL) {
      await new Promise((r) => setTimeout(r, 10))
      return tokenResponse()
    }
    if (c.auth !== 'Bearer new-access') return json(401, { error: { status: 401 } })
    if (c.url === `${API}/playlists/${PL}`) return json(200, playlist())
    const m = /\/playlists\/[^/]+\/items\?limit=100&offset=(\d+)$/.exec(c.url)
    if (m) return json(200, itemsPage(Number(m[1]), 450))
    throw new Error(`Unexpected fetch: ${c.url}`)
  })
  const provider = createSpotifyProvider('cid', dir)

  // Same shape as collectPages: one page, then the rest concurrently.
  await provider.getPlaylistTracks(PL, { limit: 100, offset: 0 })
  const pages = await Promise.all(
    [100, 200, 300, 400].map((offset) => provider.getPlaylistTracks(PL, { limit: 100, offset }))
  )

  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1)
  assert.deepEqual(pages.map((p) => p.items.length), [100, 100, 100, 50])
})

test('401 on a valid-looking token: reactive refresh once, request retried', async () => {
  storeToken()
  let apiCalls = 0
  mockFetch((c) => {
    if (c.url === TOKEN_URL) return tokenResponse()
    apiCalls++
    return c.auth === 'Bearer new-access'
      ? json(200, { items: [], total: 0 })
      : json(401, { error: { status: 401, message: 'The access token expired' } })
  })

  const page = await createSpotifyProvider('cid', dir).listPlaylists({ limit: 50 })

  assert.deepEqual(page.items, [])
  assert.equal(apiCalls, 2)
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1)
})

test('refresh token revoked (invalid_grant) → AuthRequiredError, exit 3', async () => {
  storeToken(expired())
  mockFetch((c) => {
    if (c.url === TOKEN_URL) return json(400, { error: 'invalid_grant' })
    throw new Error(`Unexpected fetch: ${c.url}`)
  })

  await assert.rejects(createSpotifyProvider('cid', dir).getPlaylist(PL), (e: unknown) => {
    assert.ok(e instanceof AuthRequiredError)
    assert.equal(e.reason, 'revoked')
    assert.equal(getExitCode(e), EXIT_CODES.AUTH_REQUIRED)
    return true
  })
})

test('still 401 after refresh → AuthRequiredError (exit 3), no refresh loop', async () => {
  storeToken()
  mockFetch((c) => (c.url === TOKEN_URL ? tokenResponse() : json(401, { error: { status: 401 } })))

  await assert.rejects(createSpotifyProvider('cid', dir).getPlaylist(PL), (e: unknown) => {
    assert.equal(getExitCode(e), EXIT_CODES.AUTH_REQUIRED)
    return true
  })
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1)
  assert.equal(calls.filter((c) => c.url !== TOKEN_URL).length, 2)
})

test('429 with Retry-After is retried and then succeeds', async () => {
  storeToken()
  let n = 0
  mockFetch(() =>
    ++n === 1
      ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
      : json(200, playlist())
  )

  const summary = await createSpotifyProvider('cid', dir).getPlaylist(PL)
  assert.equal(summary.id, PL)
  assert.equal(n, 2)
})

test('429 with a Retry-After above the wait cap → RateLimitError, exit 5', async () => {
  storeToken()
  mockFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '3600' } }))

  await assert.rejects(createSpotifyProvider('cid', dir).getPlaylist(PL), (e: unknown) => {
    assert.ok(e instanceof RateLimitError)
    assert.equal(getExitCode(e), EXIT_CODES.QUOTA_EXHAUSTED)
    return true
  })
  assert.equal(calls.length, 1)
})

test('paging a playlist checks access once, not once per page', async () => {
  storeToken()
  mockFetch((c) => {
    if (c.url === `${API}/playlists/${PL}`) return json(200, playlist())
    const m = /\/items\?limit=100&offset=(\d+)$/.exec(c.url)
    if (m) return json(200, itemsPage(Number(m[1]), 250))
    throw new Error(`Unexpected fetch: ${c.url}`)
  })
  const provider = createSpotifyProvider('cid', dir)
  await provider.getPlaylist(PL)
  for (const offset of [0, 100, 200]) await provider.getPlaylistTracks(PL, { limit: 100, offset })

  assert.equal(calls.filter((c) => c.url === `${API}/playlists/${PL}`).length, 1)
  assert.equal(calls.length, 4)
})

test('malformed container responses → ProviderError (exit 1), never a TypeError', async () => {
  storeToken()
  const bodies: unknown[] = [null, [], { items: 'nope', total: 1 }, { items: [], total: 'x' }]
  for (const body of bodies) {
    mockFetch(() => json(200, body))
    const provider = createSpotifyProvider('cid', dir)
    for (const call of [
      () => provider.listPlaylists({ limit: 50 }),
      () => provider.getLikedTracks({ limit: 50 }),
    ]) {
      await assert.rejects(call(), (e: unknown) => {
        assert.ok(e instanceof ProviderError, `expected ProviderError for ${JSON.stringify(body)}, got ${e}`)
        assert.ok(!(e instanceof TypeError))
        return true
      })
    }
  }

  mockFetch(() => new Response('<html>not json</html>', { status: 200 }))
  await assert.rejects(createSpotifyProvider('cid', dir).getPlaylist(PL), ProviderError)
})

test('no stored token → AuthRequiredError (exit 3) before any request', async () => {
  mockFetch(() => {
    throw new Error('fetch must not be called')
  })
  const provider = createSpotifyProvider('cid', dir)
  for (const call of [
    () => provider.listPlaylists({ limit: 50 }),
    () => provider.getPlaylist(PL),
    () => provider.getPlaylistTracks(PL, { limit: 100 }),
    () => provider.getLikedTracks({ limit: 50 }),
  ]) {
    await assert.rejects(call(), (e: unknown) => getExitCode(e) === EXIT_CODES.AUTH_REQUIRED)
  }
  assert.equal(calls.length, 0)
})

test('each attempt is one sple:http line: method, path, status and duration only; search q is truncated', async () => {
  storeToken()
  mockFetch(() => json(200, { tracks: { items: [], total: 0, offset: 0, limit: 10, next: null } }))
  const lines: string[] = []
  setupLogging({ verbose: false, debug: true, write: (l) => lines.push(l) })
  try {
    await createSpotifyProvider('cid', dir).search({ text: 'a very long query that should be truncated', type: 'track' }, { limit: 10 })
  } finally {
    setupLogging({ verbose: false, debug: false, write: () => {} })
  }

  const http = lines.filter((l) => / sple:http /.test(` ${l}`))
  assert.equal(http.length, 1)
  assert.match(http[0], /sple:http GET \/v1\/search\?\S+ 200 \d+ms$/)
  assert.ok(!http[0].includes('truncated'))
  assert.ok(!lines.join('\n').includes('old-access'))
})
