import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createYouTubeMusicProvider } from '../../../src/providers/youtube-music/index.js'
import { youTubeRequestCost, YOUTUBE_QUOTA_MODEL } from '../../../src/providers/youtube-music/quota.js'
import { quotaDay } from '../../../src/core/quota/ledger.js'
import { saveTokens } from '../../../src/core/config/token-store.js'
import { QuotaExhaustedError } from '../../../src/core/provider/errors.js'

const API = 'https://www.googleapis.com/youtube/v3'
const PL_ID = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'

test('request costs: search 1 from the search bucket, reads 1 unit, writes 50 units', () => {
  assert.deepStrictEqual(youTubeRequestCost({ method: 'GET', url: `${API}/search?q=x&type=video` }), { bucket: 'search', amount: 1 })
  assert.deepStrictEqual(youTubeRequestCost({ method: 'GET', url: `${API}/playlistItems?playlistId=x` }), { bucket: 'units', amount: 1 })
  assert.deepStrictEqual(youTubeRequestCost({ method: 'GET', url: `${API}/videos?id=a,b` }), { bucket: 'units', amount: 1 })
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.deepStrictEqual(youTubeRequestCost({ method, url: `${API}/playlistItems?part=snippet` }), { bucket: 'units', amount: 50 }, method)
  }
})

test('capabilities declare the ADR-0002 §4.1 daily buckets', () => {
  assert.equal(YOUTUBE_QUOTA_MODEL.kind, 'daily-buckets')
  if (YOUTUBE_QUOTA_MODEL.kind !== 'daily-buckets') return
  assert.deepStrictEqual(YOUTUBE_QUOTA_MODEL.buckets, [
    { id: 'units', dailyLimit: 10_000, resetTimeZone: 'America/Los_Angeles' },
    { id: 'search', dailyLimit: 100, resetTimeZone: 'America/Los_Angeles' },
  ])
  assert.deepStrictEqual(YOUTUBE_QUOTA_MODEL.costs.populatePlaylist, [{ bucket: 'units', amount: 50, per: 'item' }])
  assert.deepStrictEqual(YOUTUBE_QUOTA_MODEL.costs.search, [{ bucket: 'search', amount: 1, per: 'call' }])
})

function setup(used: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), 'sple-yt-quota-'))
  saveTokens('youtube-music', {
    accessToken: 'a', scopes: ['https://www.googleapis.com/auth/youtube'], userId: 'u',
    grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }, dir)
  const day = quotaDay(new Date(), 'America/Los_Angeles')
  writeFileSync(join(dir, 'quota.json'), JSON.stringify({ schemaVersion: 1, providers: { 'youtube-music': { day, used } } }))
  return createYouTubeMusicProvider('cid', 'secret', dir)
}

async function withApi<T>(respond: (url: URL) => Response, fn: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    calls.push(url.pathname.replace('/youtube/v3', ''))
    return respond(url)
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

const empty = () => Response.json({ items: [], pageInfo: { totalResults: 0 } })

test('the provider refuses a search once the search bucket is used up, without a request', async () => {
  const p = setup({ search: 99 })
  await withApi(empty, async (calls) => {
    await p.search({ text: 'x', type: 'track' }, { limit: 5 })
    await assert.rejects(() => p.search({ text: 'y', type: 'track' }, { limit: 5 }), (e: unknown) => e instanceof QuotaExhaustedError && e.bucket === 'search')
    assert.deepStrictEqual(calls, ['/search'])
  })
})

test('a 403 quotaExceeded from YouTube marks the bucket exhausted for the rest of the day', async () => {
  const p = setup({})
  const quotaExceeded = () => Response.json({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 })
  await withApi(quotaExceeded, async (calls) => {
    await assert.rejects(() => p.listPlaylists({ limit: 5 }), QuotaExhaustedError)
    await assert.rejects(() => p.getPlaylistTracks(PL_ID, { limit: 5 }), QuotaExhaustedError)
    assert.deepStrictEqual(calls, ['/playlists'])
  })
})
