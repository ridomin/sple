import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'
import { saveTokens, type StoredToken } from '../../../src/core/config/token-store.js'
import { AuthRequiredError, ProviderError, UsageError } from '../../../src/core/provider/errors.js'
import { searchAll } from '../../../src/core/search.js'
import { run } from '../../../src/cli/cli.js'
import { ProviderRegistry } from '../../../src/cli/provider-registry.js'
import { EXIT_CODES } from '../../../src/cli/exit-codes.js'
import type { SearchItem } from '../../../src/core/provider/provider.js'

const ACCESS = 'BQD-access-token'
const FIXTURES = new URL('../../fixtures/spotify/', import.meta.url)

interface Fixture {
  request: { method: string; url: string }
  status: number
  body: {
    tracks: {
      items: Array<Record<string, unknown>>
      total: number
      next: string | null
      limit: number
      offset: number
    }
  }
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as Fixture
}

const realFetch = globalThis.fetch
let requests: URL[] = []

/** Mock fetch with a function that receives the parsed request URL. */
function mockFetch(handler: (url: URL) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    requests.push(url)
    const { status, body } = handler(url)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

/**
 * Synthesize a search catalog of `total` tracks from a recorded fixture: each
 * request is answered with fixture tracks (ids suffixed with their position),
 * honoring the requested limit/offset and Spotify's `next`/`total` fields.
 */
function catalogFromFixture(fixture: Fixture, total: number) {
  const template = fixture.body.tracks.items
  return (url: URL) => {
    const limit = Number(url.searchParams.get('limit'))
    const offset = Number(url.searchParams.get('offset'))
    const count = Math.max(0, Math.min(limit, total - offset))
    const items = Array.from({ length: count }, (_, i) => {
      const src = template[(offset + i) % template.length]
      return { ...src, id: `${String(src.id)}-${offset + i}`, uri: `spotify:track:${String(src.id)}-${offset + i}` }
    })
    const next = offset + count < total ? `https://api.spotify.com/v1/search?offset=${offset + count}&limit=${limit}` : null
    return { status: 200, body: { tracks: { href: '', limit, offset, total, next, previous: null, items } } }
  }
}

function pages(): Array<{ limit: number; offset: number }> {
  return requests.map((u) => ({
    limit: Number(u.searchParams.get('limit')),
    offset: Number(u.searchParams.get('offset')),
  }))
}

test('Spotify search (M1-19)', async (t) => {
  let tempDir = ''
  let provider: ReturnType<typeof createSpotifyProvider>

  t.beforeEach(() => {
    tempDir = mkdtempSync(`${tmpdir()}/sple-search-`)
    const token: StoredToken = {
      accessToken: ACCESS,
      refreshToken: 'AQA-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: [],
      userId: 'testuser0000000000000',
      displayName: 'Test User',
      grantedAt: new Date().toISOString(),
    }
    saveTokens('spotify', token, tempDir)
    provider = createSpotifyProvider('client-id', tempDir)
    requests = []
  })

  t.afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(tempDir, { recursive: true, force: true })
  })

  // --- Fixture tests: recorded S1 responses through mocked fetch ---

  await t.test('fixture search-isrc-hello.json maps to SearchItem[] with no next page', async () => {
    const fx = loadFixture('search-isrc-hello.json')
    mockFetch(() => ({ status: fx.status, body: fx.body }))

    const page = await provider.search({ text: 'isrc:GBBKS1500214', type: 'track' }, { limit: 10 })

    assert.equal(requests.length, 1)
    assert.equal(requests[0].pathname, '/v1/search')
    assert.equal(requests[0].searchParams.get('q'), 'isrc:GBBKS1500214')
    assert.equal(requests[0].searchParams.get('type'), 'track')
    assert.equal(requests[0].searchParams.get('limit'), '10')
    assert.equal(requests[0].searchParams.get('offset'), '0')

    assert.equal(page.items.length, 2)
    assert.equal(page.total, 2)
    assert.equal(page.next, undefined)
    const first = page.items[0] as Extract<SearchItem, { type: 'track' }>
    assert.equal(first.type, 'track')
    assert.equal(first.id, '3AuzZHPlohKLpildLyORSM')
    assert.equal(first.ref, 'spotify:track:3AuzZHPlohKLpildLyORSM')
    assert.equal(first.url, 'https://open.spotify.com/track/3AuzZHPlohKLpildLyORSM')
    assert.equal(first.name, 'Hello')
    // Spike S1 recorded external_ids.isrc in search results; it is kept (FR-EXP-2).
    assert.equal(first.track.isrc, 'GBBKS1500214')
    assert.equal(first.track.refs.spotify, 'spotify:track:3AuzZHPlohKLpildLyORSM')
    assert.equal(first.track.album, 'Hello')
    assert.equal(first.track.durationMs, 295502)
    assert.ok(first.track.artists.length > 0)
    assert.equal((page.items[1] as Extract<SearchItem, { type: 'track' }>).track.album, '25')
  })

  await t.test('fixture search-isrc-shape.json: full page with next URL sets next offset', async () => {
    const fx = loadFixture('search-isrc-shape.json')
    mockFetch(() => ({ status: fx.status, body: fx.body }))

    const page = await provider.search({ text: 'isrc:GBAHS1600463', type: 'track' }, { limit: 10 })

    assert.equal(page.items.length, 10)
    assert.equal(page.total, 100)
    assert.deepEqual(page.next, { offset: 10 })
    for (const item of page.items) {
      assert.equal(item.type, 'track')
      assert.equal(item.name, 'Shape of You')
      assert.equal((item as Extract<SearchItem, { type: 'track' }>).track.durationMs, 233712)
      assert.match(item.ref, /^spotify:track:/)
    }
  })

  await t.test('fixture search-isrc-badguy.json: hasMore follows next (null), not item count', async () => {
    // Recorded quirk: 10 items, total 0, next null. An item-count heuristic would claim more pages.
    const fx = loadFixture('search-isrc-badguy.json')
    mockFetch(() => ({ status: fx.status, body: fx.body }))

    const page = await provider.search({ text: 'isrc:USUM71900764', type: 'track' }, { limit: 10 })

    assert.equal(page.items.length, 10)
    assert.equal(page.next, undefined)
    assert.ok(page.items.every((i) => i.name === 'bad guy'))
  })

  await t.test('fixtures search-isrc-bl.json and search-isrc-uptown.json map every recorded item in order', async () => {
    for (const [name, isrc] of [
      ['search-isrc-bl.json', 'USUG11904206'],
      ['search-isrc-uptown.json', 'GBARL1401524'],
    ] as const) {
      const fx = loadFixture(name)
      mockFetch(() => ({ status: fx.status, body: fx.body }))
      const page = await provider.search({ text: `isrc:${isrc}`, type: 'track' }, { limit: 10 })
      assert.equal(page.items.length, fx.body.tracks.items.length, name)
      assert.equal(page.total, fx.body.tracks.total, name)
      assert.deepEqual(page.next, { offset: 10 }, name)
      assert.deepEqual(
        page.items.map((i) => i.id),
        fx.body.tracks.items.map((i) => i.id),
        name
      )
      for (const [i, item] of page.items.entries()) {
        const raw = fx.body.tracks.items[i] as { name: string; duration_ms: number; uri: string }
        assert.equal(item.name, raw.name, name)
        assert.equal(item.ref, raw.uri, name)
        assert.equal((item as Extract<SearchItem, { type: 'track' }>).track.durationMs, raw.duration_ms, name)
      }
    }
  })

  // --- Provider-level request building ---

  await t.test('search clamps a single request to maxSearchPageSize and URL-encodes the query', async () => {
    const fx = loadFixture('search-isrc-hello.json')
    mockFetch(() => ({ status: 200, body: fx.body }))

    await provider.search({ text: 'adele & friends: hello?', type: 'album' }, { limit: 50, offset: 30 })

    assert.equal(requests.length, 1)
    assert.equal(requests[0].searchParams.get('q'), 'adele & friends: hello?')
    assert.equal(requests[0].searchParams.get('type'), 'album')
    assert.equal(requests[0].searchParams.get('limit'), '10')
    assert.equal(requests[0].searchParams.get('offset'), '30')
  })

  await t.test('search without a stored token throws AuthRequiredError (exit 3)', async () => {
    const empty = mkdtempSync(`${tmpdir()}/sple-search-empty-`)
    try {
      mockFetch(() => {
        throw new Error('fetch must not be called')
      })
      const p = createSpotifyProvider('client-id', empty)
      await assert.rejects(p.search({ text: 'x', type: 'track' }, { limit: 10 }), AuthRequiredError)
      assert.equal(requests.length, 0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  await t.test('malformed search response is rejected by validateSpotifySearchResponse', async () => {
    mockFetch(() => ({ status: 200, body: { tracks: { items: 'nope' } } }))
    await assert.rejects(
      provider.search({ text: 'x', type: 'track' }, { limit: 10 }),
      (e: unknown) => e instanceof ProviderError && /tracks\.items must be an array/.test(e.message)
    )
  })

  // --- Pagination splitting (paginate() via searchAll) ---

  await t.test('--limit 25 makes exactly 3 requests: offsets 0/10/20, limits 10/10/5', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 100))

    const page = await searchAll(provider, { text: 'shape of you', type: 'track' }, { limit: 25 })

    assert.deepEqual(pages(), [
      { offset: 0, limit: 10 },
      { offset: 10, limit: 10 },
      { offset: 20, limit: 5 },
    ])
    assert.equal(page.items.length, 25)
    assert.equal(page.items[0].id, '2d6wvuDLzBJnqbP9yuJTd5-0')
    assert.equal(page.items[24].id, `${loadFixture('search-isrc-shape.json').body.tracks.items[4].id}-24`)
    assert.deepEqual(page.next, { offset: 25 })
  })

  await t.test('--limit with --offset starts at the offset', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 100))

    const page = await searchAll(provider, { text: 'q', type: 'track' }, { limit: 15, offset: 40 })

    assert.deepEqual(pages(), [
      { offset: 40, limit: 10 },
      { offset: 50, limit: 5 },
    ])
    assert.equal(page.items.length, 15)
    assert.equal(page.items[0].id.endsWith('-40'), true)
  })

  await t.test('--limit stops early when results run out', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-uptown.json'), 13))

    const page = await searchAll(provider, { text: 'q', type: 'track' }, { limit: 25 })

    assert.deepEqual(pages(), [
      { offset: 0, limit: 10 },
      { offset: 10, limit: 10 },
    ])
    assert.equal(page.items.length, 13)
    assert.equal(page.next, undefined)
  })

  await t.test('default (no --limit) is a single request of 10', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 100))
    const page = await searchAll(provider, { text: 'q', type: 'track' })
    assert.deepEqual(pages(), [{ offset: 0, limit: 10 }])
    assert.equal(page.items.length, 10)
  })

  // --- --all with cap ---

  await t.test('--all stops at the default cap of 100 results', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 500))

    const page = await searchAll(provider, { text: 'q', type: 'track' }, { all: true })

    assert.equal(page.items.length, 100)
    assert.equal(requests.length, 10)
    assert.deepEqual(pages().map((p) => p.offset), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90])
    assert.ok(pages().every((p) => p.limit === 10))
  })

  await t.test('--all reads until results run out when below the cap', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-uptown.json'), 60))

    const page = await searchAll(provider, { text: 'q', type: 'track' }, { all: true })

    assert.equal(page.items.length, 60)
    assert.equal(page.next, undefined)
    // 6 full pages, then one empty page confirms the end.
    assert.ok(requests.length <= 7)
  })

  await t.test('--all --max-results 25 overrides the cap (10/10/5)', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 500))

    const page = await searchAll(provider, { text: 'q', type: 'track' }, { all: true, maxResults: 25 })

    assert.equal(page.items.length, 25)
    assert.deepEqual(pages(), [
      { offset: 0, limit: 10 },
      { offset: 10, limit: 10 },
      { offset: 20, limit: 5 },
    ])
  })

  await t.test('--all --max-results 1000 (the ceiling) is accepted; last request stays within offset+limit<=1000', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 5000))

    const page = await searchAll(provider, { text: 'q', type: 'track' }, { all: true, maxResults: 1000 })

    assert.equal(page.items.length, 1000)
    assert.equal(requests.length, 100)
    const last = pages().at(-1)!
    assert.ok(last.offset + last.limit <= 1000)
    assert.equal(page.next, undefined)
  })

  await t.test('--max-results above the 1000 ceiling throws UsageError before any request', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 5000))
    await assert.rejects(
      searchAll(provider, { text: 'q', type: 'track' }, { all: true, maxResults: 1001 }),
      (e: unknown) => e instanceof UsageError && /cannot exceed 1000/.test(e.message)
    )
    assert.equal(requests.length, 0)
  })

  await t.test('--offset with --all throws UsageError before any request', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 100))
    await assert.rejects(
      searchAll(provider, { text: 'q', type: 'track' }, { all: true, offset: 10 }),
      (e: unknown) => e instanceof UsageError && /--offset cannot be used with --all/.test(e.message)
    )
    assert.equal(requests.length, 0)
  })

  await t.test('--max-results without --all throws UsageError', async () => {
    await assert.rejects(
      searchAll(provider, { text: 'q', type: 'track' }, { maxResults: 50 }),
      UsageError
    )
  })

  await t.test('--offset + --limit beyond 1000 throws UsageError', async () => {
    await assert.rejects(
      searchAll(provider, { text: 'q', type: 'track' }, { offset: 995, limit: 10 }),
      UsageError
    )
  })

  // --- CLI wiring: sple search ---

  async function cli(argv: string[]) {
    const out: string[] = []
    const err: string[] = []
    const registry = new ProviderRegistry().register('spotify', () => provider)
    const code = await run(argv, {
      io: { out: (m) => out.push(m), err: (m) => err.push(m) },
      env: {},
      registry,
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  await t.test('CLI: sple search --limit 25 --quiet makes 3 requests and prints 25 IDs', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 100))

    const r = await cli(['--quiet', 'search', 'shape of you', '--limit', '25'])

    assert.equal(r.code, EXIT_CODES.SUCCESS, r.err)
    assert.deepEqual(pages(), [
      { offset: 0, limit: 10 },
      { offset: 10, limit: 10 },
      { offset: 20, limit: 5 },
    ])
    assert.equal(r.out.split('\n').length, 25)
    assert.equal(requests[0].searchParams.get('q'), 'shape of you')
  })

  await t.test('CLI: sple search --all --json stops at the cap of 100', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 500))

    const r = await cli(['--json', 'search', 'q', '--all'])

    assert.equal(r.code, EXIT_CODES.SUCCESS, r.err)
    const page = JSON.parse(r.out) as { items: SearchItem[] }
    assert.equal(page.items.length, 100)
    assert.equal(requests.length, 10)
  })

  await t.test('CLI: --all --max-results 30 overrides the cap', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 500))
    const r = await cli(['--quiet', 'search', 'q', '--all', '--max-results', '30'])
    assert.equal(r.code, EXIT_CODES.SUCCESS, r.err)
    assert.equal(r.out.split('\n').length, 30)
    assert.equal(requests.length, 3)
  })

  await t.test('CLI: --max-results 1001 exits 2', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 500))
    const r = await cli(['search', 'q', '--all', '--max-results', '1001'])
    assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
    assert.match(r.err, /cannot exceed 1000/)
    assert.equal(requests.length, 0)
  })

  await t.test('CLI: --offset with --all exits 2', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 500))
    const r = await cli(['search', 'q', '--all', '--offset', '10'])
    assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
    assert.match(r.err, /--offset cannot be used with --all/)
    assert.equal(requests.length, 0)
  })

  await t.test('CLI: invalid --type and non-numeric --limit exit 2', async () => {
    mockFetch(catalogFromFixture(loadFixture('search-isrc-shape.json'), 500))
    assert.equal((await cli(['search', 'q', '--type', 'podcast'])).code, EXIT_CODES.USAGE_ERROR)
    assert.equal((await cli(['search', 'q', '--limit', 'ten'])).code, EXIT_CODES.USAGE_ERROR)
    assert.equal((await cli(['search', 'q', '--limit', '0'])).code, EXIT_CODES.USAGE_ERROR)
    assert.equal(requests.length, 0)
  })

  await t.test('CLI: fixture search prints a table row per result with title and ID', async () => {
    const fx = loadFixture('search-isrc-hello.json')
    mockFetch(() => ({ status: 200, body: fx.body }))
    const r = await cli(['search', 'isrc:GBBKS1500214'])
    assert.equal(r.code, EXIT_CODES.SUCCESS, r.err)
    assert.match(r.out, /Hello/)
    assert.match(r.out, /3AuzZHPlohKLpildLyORSM/)
    assert.match(r.out, /62PaSfnXSMyLshYJrlTuL3/)
    assert.match(r.out, /4:56/)
  })

  await t.test('CLI: missing token exits 3', async () => {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = mkdtempSync(`${tmpdir()}/sple-search-`)
    provider = createSpotifyProvider('client-id', tempDir)
    const r = await cli(['search', 'q'])
    assert.equal(r.code, EXIT_CODES.AUTH_REQUIRED)
  })
})
