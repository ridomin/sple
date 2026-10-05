import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'
import { saveTokens, type StoredToken } from '../../../src/core/config/token-store.js'
import {
  AccessRestrictedError,
  NotFoundError,
  UsageError,
} from '../../../src/core/provider/errors.js'
import {
  mapSpotifyPlaylistToSummary,
  mapSpotifyPlaylistItems,
  determineItemsReadable,
} from '../../../src/providers/spotify/mappers.js'

const __dirname = join(fileURLToPath(import.meta.url), '..')
const API = 'https://api.spotify.com/v1'

/** Sanitized fixtures replace every user ID (owners included) with this one. */
const ME = 'testuser0000000000000'
const OTHER = 'otheruser000000000000'

const OWNED_ID = '0FRr10mglUR3E0Pq8TqlxL'
const COLLAB_ID = '5AJC5nedvehBP0eVDy6zXb'
const FOLLOWED_ID = '76IBoRDyYzi2Svw7oRRfki'
const EDITORIAL_ID = '37i9dQZF1DXcBWIGoYBM5M'

interface Recorded {
  status: number
  body: Record<string, unknown> & { items?: unknown; owner?: Record<string, unknown> }
}

function loadFixture(filename: string): Recorded {
  const path = join(__dirname, '..', '..', 'fixtures', 'spotify', filename)
  return JSON.parse(readFileSync(path, 'utf-8')) as Recorded
}

/**
 * The sanitizer replaced real owner IDs with ME, so the collab and followed
 * playlist fixtures look owned. Restore "owned by someone else" for tests.
 */
function ownedByOther(fixture: Recorded): Recorded['body'] {
  return { ...fixture.body, owner: { ...fixture.body.owner, id: OTHER, display_name: 'Other User' } }
}

// --- fetch mock (same pattern as write.test.ts) ---------------------------

interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

type Responder = (call: Call) => Response | Promise<Response>

const realFetch = globalThis.fetch
let calls: Call[]
let tempDir: string

function mockFetch(routes: Record<string, Responder>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    }
    calls.push(call)
    const route = routes[url]
    if (!route) throw new Error(`Unexpected fetch: ${url}`)
    return route(call)
  }) as typeof fetch
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function saveToken(scopes: string[] = ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read']) {
  const token: StoredToken = {
    accessToken: 'BQD-access-token',
    refreshToken: 'AQA-refresh-token',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    scopes,
    userId: ME,
    displayName: 'Test User',
    grantedAt: new Date().toISOString(),
  }
  saveTokens('spotify', token, tempDir)
}

function track(n: number) {
  return {
    type: 'track',
    id: `track${String(n).padStart(4, '0')}`,
    name: `Song ${n}`,
    artists: [{ name: `Artist ${n}` }],
    album: { name: `Album ${n}` },
    duration_ms: 180000 + n,
    uri: `spotify:track:track${String(n).padStart(4, '0')}`,
  }
}

/** Distinct, strictly decreasing timestamps (Liked Songs come newest first). */
function addedAt(n: number): string {
  return new Date(Date.UTC(2026, 0, 1) - n * 60000).toISOString().replace('.000Z', 'Z')
}

/** A page of GET /me/tracks for a library of `total` saved tracks. */
function likedPage(offset: number, limit: number, total: number) {
  const items = []
  for (let n = offset; n < Math.min(offset + limit, total); n++) {
    items.push({ added_at: addedAt(n), track: track(n) })
  }
  return { href: '', items, limit, offset, total, next: null, previous: null }
}

/** A page of GET /playlists/{id}/items for a playlist of `total` tracks. */
function itemsPage(offset: number, limit: number, total: number) {
  const items = []
  for (let n = offset; n < Math.min(offset + limit, total); n++) {
    items.push({ added_at: addedAt(n), is_local: false, item: track(n) })
  }
  return { href: '', items, limit, offset, total, next: null, previous: null }
}

function simplifiedPlaylist(id: string, ownerId: string, name: string) {
  return {
    id,
    name,
    collaborative: false,
    public: true,
    description: '',
    owner: { id: ownerId, display_name: ownerId === ME ? 'Test User' : 'Other User' },
    items: { href: `${API}/playlists/${id}/items`, total: 3 },
    uri: `spotify:playlist:${id}`,
  }
}

const itemsUrl = (id: string, limit: number, offset: number) =>
  `${API}/playlists/${id}/items?limit=${limit}&offset=${offset}`

test('Spotify read operations through the provider (M1-20)', async (t) => {
  t.beforeEach(() => {
    calls = []
    tempDir = mkdtempSync(`${tmpdir()}/sple-read-test-`)
    saveToken()
  })

  t.afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(tempDir, { recursive: true, force: true })
  })

  // --- listPlaylists ------------------------------------------------------

  const libraryPage = {
    href: '',
    limit: 50,
    offset: 0,
    next: null,
    previous: null,
    total: 4,
    items: [
      simplifiedPlaylist('pl0000000000000000000a', ME, 'Mine A'),
      simplifiedPlaylist('pl0000000000000000000b', OTHER, 'Followed B'),
      simplifiedPlaylist('pl0000000000000000000c', ME, 'Mine C'),
      simplifiedPlaylist('pl0000000000000000000d', OTHER, 'Followed D'),
    ],
  }

  await t.test('listPlaylists without filter returns every playlist with owned derived from token.userId', async () => {
    mockFetch({ [`${API}/me/playlists?limit=50&offset=0`]: () => json(200, libraryPage) })

    const page = await createSpotifyProvider('cid', tempDir).listPlaylists({ limit: 50 })

    assert.deepEqual(page.items.map((p) => p.name), ['Mine A', 'Followed B', 'Mine C', 'Followed D'])
    assert.deepEqual(page.items.map((p) => p.owned), [true, false, true, false])
    assert.equal(page.total, 4)
    assert.equal(page.next, undefined)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers.authorization, 'Bearer BQD-access-token')
  })

  await t.test('listPlaylists with owned filter returns owned playlists only', async () => {
    mockFetch({ [`${API}/me/playlists?limit=50&offset=0`]: () => json(200, libraryPage) })

    const page = await createSpotifyProvider('cid', tempDir).listPlaylists({ limit: 50 }, 'owned')

    assert.deepEqual(page.items.map((p) => p.name), ['Mine A', 'Mine C'])
    assert.ok(page.items.every((p) => p.owned && p.owner.id === ME))
    assert.equal(page.total, undefined, 'unfiltered Spotify total is not reported for a filtered page')
    assert.deepEqual(calls.map((c) => c.url), [`${API}/me/playlists?limit=50&offset=0`])
  })

  await t.test('listPlaylists with followed filter returns non-owned playlists only', async () => {
    mockFetch({ [`${API}/me/playlists?limit=50&offset=0`]: () => json(200, libraryPage) })

    const page = await createSpotifyProvider('cid', tempDir).listPlaylists({ limit: 50 }, 'followed')

    assert.deepEqual(page.items.map((p) => p.name), ['Followed B', 'Followed D'])
    assert.ok(page.items.every((p) => !p.owned && p.owner.id === OTHER))
    assert.equal(calls.length, 1)
  })

  await t.test('listPlaylists paginates by offset and caps limit at 50', async () => {
    const many = (offset: number, count: number) => ({
      ...libraryPage,
      offset,
      total: 60,
      items: Array.from({ length: count }, (_, i) =>
        simplifiedPlaylist(`pl${String(offset + i).padStart(20, '0')}`, (offset + i) % 2 ? OTHER : ME, `P${offset + i}`)
      ),
    })
    mockFetch({
      [`${API}/me/playlists?limit=50&offset=0`]: () => json(200, many(0, 50)),
      [`${API}/me/playlists?limit=50&offset=50`]: () => json(200, many(50, 10)),
    })
    const provider = createSpotifyProvider('cid', tempDir)

    const first = await provider.listPlaylists({ limit: 500 }, 'owned')
    assert.deepEqual(first.next, { offset: 50 })
    assert.equal(first.items.length, 25)
    const second = await provider.listPlaylists({ limit: 500, offset: first.next!.offset }, 'owned')
    assert.equal(second.next, undefined)
    assert.deepEqual(second.items.map((p) => p.name), ['P50', 'P52', 'P54', 'P56', 'P58'])
  })

  // --- getPlaylist --------------------------------------------------------

  await t.test('getPlaylist for an owned playlist returns all metadata', async () => {
    mockFetch({ [`${API}/playlists/${OWNED_ID}`]: () => json(200, loadFixture('s2-owned-pl.json').body) })

    const summary = await createSpotifyProvider('cid', tempDir).getPlaylist(OWNED_ID)

    assert.equal(summary.id, OWNED_ID)
    assert.equal(summary.ref, OWNED_ID)
    assert.equal(summary.name, 'FlamenRock')
    assert.deepEqual(summary.owner, { id: ME, displayName: 'Test User' })
    assert.equal(summary.owned, true)
    assert.equal(summary.itemsReadable, true)
    assert.equal(summary.public, true)
    assert.equal(summary.trackCount, 5)
    assert.equal(summary.url, `https://open.spotify.com/playlist/${OWNED_ID}`)
  })

  await t.test('getPlaylist accepts a URI or URL and requests the bare ID', async () => {
    mockFetch({ [`${API}/playlists/${OWNED_ID}`]: () => json(200, loadFixture('s2-owned-pl.json').body) })
    const provider = createSpotifyProvider('cid', tempDir)

    await provider.getPlaylist(`spotify:playlist:${OWNED_ID}`)
    await provider.getPlaylist(`https://open.spotify.com/playlist/${OWNED_ID}?si=abc`)

    assert.deepEqual(calls.map((c) => c.url), [`${API}/playlists/${OWNED_ID}`, `${API}/playlists/${OWNED_ID}`])
  })

  await t.test('getPlaylist rejects an unresolved name before any request', async () => {
    mockFetch({})
    await assert.rejects(createSpotifyProvider('cid', tempDir).getPlaylist('My Mix'), UsageError)
    assert.equal(calls.length, 0)
  })

  await t.test('getPlaylist for a followed playlist reports itemsReadable=false', async () => {
    mockFetch({ [`${API}/playlists/${FOLLOWED_ID}`]: () => json(200, ownedByOther(loadFixture('s2-followed-pl.json'))) })

    const summary = await createSpotifyProvider('cid', tempDir).getPlaylist(FOLLOWED_ID)

    assert.equal(summary.owned, false)
    assert.equal(summary.itemsReadable, false)
  })

  await t.test('getPlaylist for a collaborator playlist reports itemsReadable=true despite collaborative=false (S2)', async () => {
    const body = ownedByOther(loadFixture('s2-collab-pl.json'))
    assert.equal(body.collaborative, false, 'recorded S2 fixture: the flag is unreliable')
    mockFetch({ [`${API}/playlists/${COLLAB_ID}`]: () => json(200, body) })

    const summary = await createSpotifyProvider('cid', tempDir).getPlaylist(COLLAB_ID)

    assert.equal(summary.owned, false)
    assert.equal(summary.itemsReadable, true)
  })

  await t.test('getPlaylist for an editorial playlist (404) throws NotFoundError', async () => {
    const fx = loadFixture('s2-editorial-pl.json')
    mockFetch({ [`${API}/playlists/${EDITORIAL_ID}`]: () => json(fx.status, fx.body) })

    await assert.rejects(createSpotifyProvider('cid', tempDir).getPlaylist(EDITORIAL_ID), NotFoundError)
  })

  // --- getPlaylistTracks --------------------------------------------------

  await t.test('getPlaylistTracks for an owned playlist reads items from the recorded fixture', async () => {
    const items = loadFixture('s2-owned-items.json').body
    mockFetch({
      [`${API}/playlists/${OWNED_ID}`]: () => json(200, loadFixture('s2-owned-pl.json').body),
      [itemsUrl(OWNED_ID, 2, 0)]: () => json(200, items),
    })

    const page = await createSpotifyProvider('cid', tempDir).getPlaylistTracks(OWNED_ID, { limit: 2 })

    assert.equal(page.items.length, 2)
    assert.equal(page.total, 5)
    assert.deepEqual(page.next, { offset: 2 })
    const expected = mapSpotifyPlaylistItems((items as { items: unknown[] }).items).map((i) => i.track?.refs.spotify)
    assert.deepEqual(page.items.map((tr) => tr.refs.spotify), expected)
    assert.deepEqual(calls.map((c) => c.url), [`${API}/playlists/${OWNED_ID}`, itemsUrl(OWNED_ID, 2, 0)])
  })

  await t.test('getPlaylistTracks for a non-owned playlist fails with not-owned BEFORE the items request', async () => {
    // Only the playlist route exists: an /items request would throw "Unexpected fetch".
    mockFetch({ [`${API}/playlists/${FOLLOWED_ID}`]: () => json(200, ownedByOther(loadFixture('s2-followed-pl.json'))) })

    await assert.rejects(
      createSpotifyProvider('cid', tempDir).getPlaylistTracks(FOLLOWED_ID, { limit: 100 }),
      (err: unknown) => {
        assert.ok(err instanceof AccessRestrictedError)
        assert.equal(err.reason, 'not-owned')
        assert.match(err.message, /collaborat/)
        assert.match(err.message, /playlist you own/)
        return true
      }
    )
    assert.equal(calls.length, 1)
    assert.ok(!calls.some((c) => c.url.includes('/items')), '/items must never be requested')
  })

  await t.test('getPlaylistTracks for a collaborator playlist (not owned) reads items', async () => {
    mockFetch({
      [`${API}/playlists/${COLLAB_ID}`]: () => json(200, ownedByOther(loadFixture('s2-collab-pl.json'))),
      [itemsUrl(COLLAB_ID, 2, 0)]: () => json(200, loadFixture('s2-collab-items.json').body),
    })

    const page = await createSpotifyProvider('cid', tempDir).getPlaylistTracks(COLLAB_ID, { limit: 2 })

    assert.equal(page.items.length, 2)
    assert.equal(page.total, 3)
    assert.equal(calls.length, 2)
  })

  await t.test('getPlaylistTracks maps an /items 403 after a readable check to not-owned (access changed)', async () => {
    const fx = loadFixture('s2-followed-items.json')
    mockFetch({
      [`${API}/playlists/${COLLAB_ID}`]: () => json(200, ownedByOther(loadFixture('s2-collab-pl.json'))),
      [itemsUrl(COLLAB_ID, 100, 0)]: () => json(fx.status, fx.body),
    })

    await assert.rejects(
      createSpotifyProvider('cid', tempDir).getPlaylistTracks(COLLAB_ID, { limit: 100 }),
      (err: unknown) => {
        assert.ok(err instanceof AccessRestrictedError)
        assert.equal(err.reason, 'not-owned')
        assert.match(err.message, /changed/)
        assert.match(err.message, /collaborat/)
        return true
      }
    )
  })

  await t.test('getPlaylistTracks maps an /items 404 after a readable check to not-owned (access changed)', async () => {
    const fx = loadFixture('s2-editorial-items.json')
    mockFetch({
      [`${API}/playlists/${OWNED_ID}`]: () => json(200, loadFixture('s2-owned-pl.json').body),
      [itemsUrl(OWNED_ID, 100, 0)]: () => json(fx.status, fx.body),
    })

    await assert.rejects(
      createSpotifyProvider('cid', tempDir).getPlaylistTracks(OWNED_ID, { limit: 100 }),
      (err: unknown) => err instanceof AccessRestrictedError && err.reason === 'not-owned'
    )
  })

  await t.test('getPlaylistTracks keeps a Premium-required 403 on /items as premium-required', async () => {
    mockFetch({
      [`${API}/playlists/${OWNED_ID}`]: () => json(200, loadFixture('s2-owned-pl.json').body),
      [itemsUrl(OWNED_ID, 100, 0)]: () => json(403, { error: { status: 403, message: 'PREMIUM_REQUIRED' } }),
    })

    await assert.rejects(
      createSpotifyProvider('cid', tempDir).getPlaylistTracks(OWNED_ID, { limit: 100 }),
      (err: unknown) => err instanceof AccessRestrictedError && err.reason === 'premium-required'
    )
  })

  await t.test('getPlaylistTracks with 120 items across 2 pages preserves order', async () => {
    const total = 120
    mockFetch({
      [`${API}/playlists/${OWNED_ID}`]: () => json(200, loadFixture('s2-owned-pl.json').body),
      [itemsUrl(OWNED_ID, 100, 0)]: () => json(200, itemsPage(0, 100, total)),
      [itemsUrl(OWNED_ID, 100, 100)]: () => json(200, itemsPage(100, 100, total)),
    })
    const provider = createSpotifyProvider('cid', tempDir)

    const all = []
    let offset: number | undefined = 0
    let pages = 0
    while (offset !== undefined) {
      const page = await provider.getPlaylistTracks(OWNED_ID, { limit: 500, offset })
      all.push(...page.items)
      offset = page.next?.offset
      pages++
    }

    assert.equal(pages, 2)
    assert.equal(all.length, total)
    assert.deepEqual(all.map((tr) => tr.title), Array.from({ length: total }, (_, n) => `Song ${n}`))
  })

  // --- getLikedTracks -----------------------------------------------------

  await t.test('getLikedTracks with 120+ liked songs paginates across 3 pages, preserving order and added_at', async () => {
    const total = 123
    mockFetch({
      [`${API}/me/tracks?limit=50&offset=0`]: () => json(200, likedPage(0, 50, total)),
      [`${API}/me/tracks?limit=50&offset=50`]: () => json(200, likedPage(50, 50, total)),
      [`${API}/me/tracks?limit=50&offset=100`]: () => json(200, likedPage(100, 50, total)),
    })
    const provider = createSpotifyProvider('cid', tempDir)

    const all = []
    let offset: number | undefined = 0
    while (offset !== undefined) {
      // limit above the S3 maximum is capped to 50 per request
      const page = await provider.getLikedTracks({ limit: 500, offset })
      assert.equal(page.total, total)
      all.push(...page.items)
      offset = page.next?.offset
    }

    assert.deepEqual(calls.map((c) => c.url), [
      `${API}/me/tracks?limit=50&offset=0`,
      `${API}/me/tracks?limit=50&offset=50`,
      `${API}/me/tracks?limit=50&offset=100`,
    ])
    assert.equal(all.length, total)
    assert.deepEqual(all.map((tr) => tr.refs.spotify), Array.from({ length: total }, (_, n) => track(n).uri))
    assert.deepEqual(all.map((tr) => tr.addedAt), Array.from({ length: total }, (_, n) => addedAt(n)))
    assert.equal(all[0].album, 'Album 0')
    assert.equal(all[0].durationMs, 180000)
    assert.equal(all[0].isrc, null)
  })

  await t.test('getLikedTracks without user-library-read fails before any request', async () => {
    saveToken(['playlist-read-private'])
    mockFetch({})
    await assert.rejects(createSpotifyProvider('cid', tempDir).getLikedTracks({ limit: 50 }))
    assert.equal(calls.length, 0)
  })
})

test('Spotify read mappers (M1-20)', async (t) => {
  await t.test('mapSpotifyPlaylistToSummary maps the owned fixture', () => {
    const summary = mapSpotifyPlaylistToSummary(loadFixture('s2-owned-pl.json').body, ME, true)
    assert.equal(summary.id, OWNED_ID)
    assert.equal(summary.name, 'FlamenRock')
    assert.equal(summary.owned, true)
    assert.equal(summary.trackCount, 5)
  })

  await t.test('mapSpotifyPlaylistToSummary marks the followed fixture as not owned for another user', () => {
    const summary = mapSpotifyPlaylistToSummary(loadFixture('s2-followed-pl.json').body, OTHER, false)
    assert.equal(summary.owned, false)
    assert.equal(summary.itemsReadable, false)
  })

  await t.test('mapSpotifyPlaylistItems numbers positions from startPosition in order', () => {
    const items = (loadFixture('s2-owned-items.json').body as { items: unknown[] }).items
    const mapped = mapSpotifyPlaylistItems(items, 10)
    assert.deepEqual(mapped.map((i) => i.position), items.map((_, i) => 10 + i))
  })

  await t.test('determineItemsReadable follows the capability', () => {
    assert.equal(determineItemsReadable('owned-or-collaborator', true, false), true)
    assert.equal(determineItemsReadable('owned-or-collaborator', false, true), true)
    assert.equal(determineItemsReadable('owned-or-collaborator', false, false), false)
    assert.equal(determineItemsReadable('owned-only', false, true), false)
    assert.equal(determineItemsReadable('all', false, false), true)
  })
})
