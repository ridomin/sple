import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'
import { saveTokens } from '../../../src/core/config/token-store.js'
import { AuthRequiredError, RateLimitError } from '../../../src/core/provider/errors.js'

// ADR-0003 A2 "Spotify endpoints used": POST /v1/playlists/{id}/items { uris },
// at most 100 per request, in order.

const PLAYLIST = '0FRr10mglUR3E0Pq8TqlxL'
const uri = (i: number) => `spotify:track:${String(i).padStart(22, '0')}`
const realFetch = globalThis.fetch

interface Call { method: string; url: URL; body?: { uris: string[] } }

test('Spotify populatePlaylist', async (t) => {
  let dir = ''
  let calls: Call[] = []

  const login = (scopes = ['playlist-modify-public', 'playlist-modify-private', 'playlist-read-private']) =>
    saveTokens('spotify', {
      accessToken: 'at',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes,
      userId: 'me',
      grantedAt: new Date().toISOString(),
    }, dir)

  /** Answer POSTs with `post(call)` (default 201) and GETs of /items with `existing`. */
  const mockFetch = (post: (call: Call) => Response = () => Response.json({ snapshot_id: 's' }, { status: 201 }), existing: string[] = []) => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: new URL(String(input)),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }
      calls.push(call)
      if (call.method === 'POST') return post(call)
      const offset = Number(call.url.searchParams.get('offset') ?? 0)
      const limit = Number(call.url.searchParams.get('limit') ?? 100)
      const page = existing.slice(offset, offset + limit)
      return Response.json({
        items: page.map((u) => ({ added_at: '2026-01-01T00:00:00Z', is_local: false, item: { type: 'track', uri: u, id: u.slice(14), name: 'x', artists: [{ name: 'a' }], album: { name: 'b' }, duration_ms: 1 } })),
        total: existing.length,
        limit,
        offset,
        next: offset + limit < existing.length ? 'more' : null,
      })
    }) as typeof fetch
  }

  t.beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/sple-populate-`)
    calls = []
  })
  t.afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  await t.test('adds refs in order, at most 100 per request', async () => {
    login()
    mockFetch()
    const refs = Array.from({ length: 250 }, (_, i) => uri(i))

    const result = await createSpotifyProvider('cid', dir).populatePlaylist(PLAYLIST, refs, { skipExisting: false })

    assert.deepEqual(calls.map((c) => [c.method, c.url.pathname, c.body?.uris.length]), [
      ['POST', `/v1/playlists/${PLAYLIST}/items`, 100],
      ['POST', `/v1/playlists/${PLAYLIST}/items`, 100],
      ['POST', `/v1/playlists/${PLAYLIST}/items`, 50],
    ])
    assert.deepEqual(calls.flatMap((c) => c.body!.uris), refs)
    assert.deepEqual(result, { added: refs, failed: [] })
  })

  await t.test('refs that are not Spotify track URIs fail without a request', async () => {
    login()
    mockFetch()
    const result = await createSpotifyProvider('cid', dir).populatePlaylist(
      PLAYLIST,
      [uri(1), 'https://www.youtube.com/watch?v=aaaaaaaaaaa', uri(2)],
      { skipExisting: false }
    )
    assert.deepEqual(calls.map((c) => c.body?.uris), [[uri(1), uri(2)]])
    assert.deepEqual(result.added, [uri(1), uri(2)])
    assert.deepEqual(result.failed, [{ ref: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', error: 'Not a Spotify track URI' }])
  })

  await t.test('a failed batch is reported per track and later batches still run', async () => {
    login()
    let n = 0
    mockFetch(() => (++n === 1 ? Response.json({ error: { status: 400, message: 'Invalid base62 id' } }, { status: 400 }) : Response.json({ snapshot_id: 's' }, { status: 201 })))
    const refs = Array.from({ length: 101 }, (_, i) => uri(i))

    const result = await createSpotifyProvider('cid', dir).populatePlaylist(PLAYLIST, refs, { skipExisting: false })

    assert.deepEqual(result.added, [uri(100)])
    assert.equal(result.failed.length, 100)
    assert.deepEqual(result.failed[0].ref, uri(0))
    assert.match(result.failed[0].error, /HTTP 400/)
  })

  await t.test('a rate limit stops the run', async () => {
    login()
    mockFetch(() => new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } }))
    await assert.rejects(
      () => createSpotifyProvider('cid', dir).populatePlaylist(PLAYLIST, [uri(1)], { skipExisting: false }),
      RateLimitError
    )
  })

  await t.test('requires both modify scopes before any request', async () => {
    login(['playlist-read-private'])
    mockFetch()
    await assert.rejects(
      () => createSpotifyProvider('cid', dir).populatePlaylist(PLAYLIST, [uri(1)], { skipExisting: false }),
      AuthRequiredError
    )
    assert.equal(calls.length, 0)
  })

  await t.test('skipExisting skips refs already in the playlist', async () => {
    login()
    mockFetch(undefined, [uri(1)])
    const result = await createSpotifyProvider('cid', dir).populatePlaylist(PLAYLIST, [uri(1), uri(2)], { skipExisting: true })
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body?.uris), [[uri(2)]])
    assert.deepEqual(result, { added: [uri(2)], failed: [] })
  })
})
