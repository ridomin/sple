import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createYouTubeMusicProvider } from '../../../src/providers/youtube-music/index.js'
import { saveTokens } from '../../../src/core/config/token-store.js'

// ADR-0003 Amendment 2: the adapter turns a TrackQuery into YouTube search syntax.

test('YouTube Music searchTracks', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'sple-yt-search-tracks-'))
  const originalFetch = globalThis.fetch
  let requests: URL[] = []
  saveTokens('youtube-music', {
    accessToken: 'test-token',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    userId: 'test-user',
    scopes: ['https://www.googleapis.com/auth/youtube'],
    grantedAt: new Date().toISOString(),
  }, tempDir)
  const provider = createYouTubeMusicProvider('client-id', 'client-secret', tempDir)

  t.beforeEach(() => {
    requests = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      requests.push(url)
      if (url.pathname.endsWith('/search')) {
        return Response.json({
          items: [{ id: { videoId: 'aaaaaaaaaaa' } }, { id: { videoId: 'bbbbbbbbbbb' } }],
          pageInfo: { totalResults: 2, resultsPerPage: 2 },
        })
      }
      if (url.pathname.endsWith('/videos')) {
        const ids = (url.searchParams.get('id') ?? '').split(',')
        return Response.json({
          items: ids.map((id) => ({
            id,
            snippet: { title: `Video ${id}`, channelTitle: 'Artist - Topic', publishedAt: '2020-01-01T00:00:00Z' },
            contentDetails: { duration: 'PT3M5S' },
          })),
          pageInfo: { totalResults: ids.length, resultsPerPage: ids.length },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch
  })
  t.afterEach(() => { globalThis.fetch = originalFetch })
  t.after(() => rmSync(tempDir, { recursive: true, force: true }))

  await t.test('a metadata query searches "<title> <artists>" and maps hits', async () => {
    const hits = await provider.searchTracks(
      { kind: 'metadata', title: 'Hello', artists: ['Adele'], durationMs: 295000 },
      { limit: 10 }
    )

    const search = requests.find((u) => u.pathname.endsWith('/search'))!
    assert.equal(search.searchParams.get('q'), 'Hello Adele')
    assert.equal(search.searchParams.get('maxResults'), '10')
    assert.equal(search.searchParams.get('type'), 'video')
    assert.equal(search.searchParams.get('videoCategoryId'), '10', 'Music category (ADR-0002 R3)')
    assert.equal(hits.length, 2)
    assert.equal(hits[0].ref, 'aaaaaaaaaaa')
    assert.equal(hits[0].track.refs['youtube-music'], 'aaaaaaaaaaa')
    assert.equal(hits[0].track.title, 'Video aaaaaaaaaaa')
    assert.equal(hits[0].track.durationMs, 185000)
  })

  await t.test('Topic-channel hits are ranked first, otherwise the API order is kept', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      requests.push(url)
      if (url.pathname.endsWith('/search')) {
        return Response.json({
          items: ['vvvvvvvvvv1', 'ttttttttttt', 'vvvvvvvvvv2'].map((videoId) => ({ id: { videoId } })),
          pageInfo: { totalResults: 3, resultsPerPage: 3 },
        })
      }
      const ids = (url.searchParams.get('id') ?? '').split(',')
      return Response.json({
        items: ids.map((id) => ({
          id,
          snippet: { title: 'Hello', channelTitle: id === 'ttttttttttt' ? 'Adele - Topic' : 'AdeleVEVO' },
          contentDetails: { duration: 'PT4M55S' },
        })),
        pageInfo: { totalResults: ids.length, resultsPerPage: ids.length },
      })
    }) as typeof fetch
    const hits = await provider.searchTracks({ kind: 'metadata', title: 'Hello', artists: ['Adele'] }, { limit: 10 })
    assert.deepEqual(hits.map((h) => h.ref), ['ttttttttttt', 'vvvvvvvvvv1', 'vvvvvvvvvv2'])
    assert.deepEqual(hits[0].track.artists, ['Adele'])
  })

  await t.test('the search command does not restrict the category', async () => {
    await provider.search({ text: 'Hello', type: 'track' }, { limit: 5 })
    const search = requests.find((u) => u.pathname.endsWith('/search'))!
    assert.equal(search.searchParams.get('videoCategoryId'), null)
  })

  await t.test('an ISRC query returns no hits without a request (isrcSearchMode is none)', async () => {
    const hits = await provider.searchTracks({ kind: 'isrc', isrc: 'GBBKS1500214' }, { limit: 5 })
    assert.deepEqual(hits, [])
    assert.equal(requests.length, 0)
  })
})
