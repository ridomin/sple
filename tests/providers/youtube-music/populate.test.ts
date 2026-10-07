import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createYouTubeMusicProvider } from '../../../src/providers/youtube-music/index.js'
import { YouTubeMusicHttpClient } from '../../../src/providers/youtube-music/client.js'
import { YouTubeConflictError } from '../../../src/providers/youtube-music/errors.js'
import { saveTokens } from '../../../src/core/config/token-store.js'
import { QuotaExhaustedError } from '../../../src/core/provider/errors.js'
import type { HttpClient } from '../../../src/core/http/client.js'

const PLAYLIST = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'
const video = (id: string) => `https://www.youtube.com/watch?v=${id}`
const error = (status: number, reason: string) =>
  Response.json({ error: { code: status, message: 'm', errors: [{ reason }] } }, { status })

test('YouTube Music HTTP errors (#27)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sple-yt-errors-'))
  const realFetch = globalThis.fetch
  let calls: Array<{ method: string; url: URL }> = []
  saveTokens('youtube-music', {
    accessToken: 'test-token',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    userId: 'test-user',
    scopes: ['https://www.googleapis.com/auth/youtube'],
    grantedAt: new Date().toISOString(),
  }, dir)
  const provider = createYouTubeMusicProvider('cid', 'secret', dir)

  const mockFetch = (handler: (method: string, url: URL) => Response) => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      return handler(method, url)
    }) as typeof fetch
  }

  // Simulated quotaExceeded responses mark the ledger exhausted; each subtest starts a fresh quota day.
  t.beforeEach(() => { calls = []; rmSync(join(dir, 'quota.json'), { force: true }) })
  t.afterEach(() => { globalThis.fetch = realFetch })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  await t.test('a quota error from search is QuotaExhaustedError', async () => {
    mockFetch(() => error(403, 'quotaExceeded'))
    await assert.rejects(
      () => provider.searchTracks({ kind: 'metadata', title: 'Hello', artists: ['Adele'] }, { limit: 5 }),
      QuotaExhaustedError
    )
  })

  await t.test('populatePlaylist stops at a quota error instead of trying every track', async () => {
    mockFetch(() => error(403, 'quotaExceeded'))
    await assert.rejects(
      () => provider.populatePlaylist(PLAYLIST, [video('aaaaaaaaaaa'), video('bbbbbbbbbbb')], { skipExisting: false }),
      QuotaExhaustedError
    )
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
  })

  await t.test('a per-track error keeps the reason and the next track still runs', async () => {
    let n = 0
    mockFetch(() => (++n === 1 ? error(404, 'videoNotFound') : Response.json({ id: 'x' })))
    const result = await provider.populatePlaylist(PLAYLIST, [video('aaaaaaaaaaa'), video('bbbbbbbbbbb')], { skipExisting: false })
    assert.deepEqual(result.added, [video('bbbbbbbbbbb')])
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].error, /videoNotFound/)
  })
})

test('YouTubeMusicHttpClient.populatePlaylist retries a 409 conflict (#27)', async (t) => {
  const run = async (failures: number) => {
    let attempts = 0
    const http = {
      request: async () => {
        attempts++
        if (attempts <= failures) throw new YouTubeConflictError('YouTube API request failed (HTTP 409, SERVICE_UNAVAILABLE)')
        return { status: 200, headers: new Map(), body: '{}' }
      },
    } as unknown as HttpClient
    const client = new YouTubeMusicHttpClient(http, { conflictRetryDelaysMs: [0, 0] })
    const result = await client.populatePlaylist(PLAYLIST, [video('aaaaaaaaaaa')], { skipExisting: false })
    return { result, attempts }
  }

  await t.test('a transient 409 is retried and the track is added', async () => {
    const { result, attempts } = await run(1)
    assert.equal(attempts, 2)
    assert.deepEqual(result, { added: [video('aaaaaaaaaaa')], failed: [] })
  })

  await t.test('a persistent 409 fails the track after the retries run out', async () => {
    const { result, attempts } = await run(5)
    assert.equal(attempts, 3)
    assert.deepEqual(result.added, [])
    assert.match(result.failed[0].error, /HTTP 409, SERVICE_UNAVAILABLE/)
  })
})
