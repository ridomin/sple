import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createYouTubeMusicProvider } from '../../../src/providers/youtube-music/index.js'
import {
  YOUTUBE_SCOPE,
  YOUTUBE_READONLY_SCOPE,
  YOUTUBE_LOGIN_SCOPES,
  YOUTUBE_OPERATION_SCOPES,
} from '../../../src/providers/youtube-music/scopes.js'
import { saveTokens } from '../../../src/core/config/token-store.js'
import { AuthRequiredError } from '../../../src/core/provider/errors.js'

const PROFILE = 'https://www.googleapis.com/auth/userinfo.profile'
const PL_ID = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'
const READS = ['search', 'searchTracks', 'listPlaylists', 'getPlaylist', 'getPlaylistTracks', 'getLikedTracks'] as const
const WRITES = ['createPlaylist', 'removePlaylist', 'populatePlaylist'] as const

function providerWithScopes(scopes: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'sple-yt-scopes-'))
  saveTokens('youtube-music', {
    accessToken: 'a', refreshToken: 'r', scopes, userId: 'u', grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }, dir)
  return createYouTubeMusicProvider('cid', 'secret', dir)
}

/** Answer every Data API call with an empty list, recording the paths. */
async function withEmptyApi<T>(fn: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    calls.push(url.pathname)
    if (url.pathname.endsWith('/playlists') && url.searchParams.get('id')) {
      return Response.json({ items: [{ id: PL_ID, snippet: { title: 't', channelId: 'c', channelTitle: 'c' }, contentDetails: { itemCount: 0 }, status: { privacyStatus: 'private' } }] })
    }
    return Response.json({ items: [], pageInfo: { totalResults: 0 } })
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

const isMissingYoutube = (e: unknown) =>
  e instanceof AuthRequiredError && e.reason === 'missing-scope' && e.scope === YOUTUBE_SCOPE

test('scope table: login requests youtube + profile; reads accept readonly or youtube; writes need youtube', () => {
  assert.deepStrictEqual([...YOUTUBE_LOGIN_SCOPES], [YOUTUBE_SCOPE, PROFILE])
  for (const op of READS) assert.deepStrictEqual(YOUTUBE_OPERATION_SCOPES[op], [YOUTUBE_SCOPE, YOUTUBE_READONLY_SCOPE], op)
  for (const op of WRITES) assert.deepStrictEqual(YOUTUBE_OPERATION_SCOPES[op], [YOUTUBE_SCOPE], op)
})

test('reads work with only youtube.readonly granted', async () => {
  const p = providerWithScopes([YOUTUBE_READONLY_SCOPE, PROFILE])
  await withEmptyApi(async (calls) => {
    await p.search({ text: 'x', type: 'track' }, { limit: 5 })
    await p.searchTracks({ kind: 'metadata', title: 't', artists: ['a'] }, { limit: 5 })
    await p.listPlaylists({ limit: 5 })
    await p.getPlaylist(PL_ID)
    await p.getPlaylistTracks(PL_ID, { limit: 5 })
    await p.getLikedTracks({ limit: 5 })
    assert.ok(calls.length > 0)
  })
})

test('writes with only youtube.readonly fail with missing-scope youtube before any request', async () => {
  const p = providerWithScopes([YOUTUBE_READONLY_SCOPE, PROFILE])
  await withEmptyApi(async (calls) => {
    await assert.rejects(() => p.createPlaylist({ name: 'n' }), isMissingYoutube)
    await assert.rejects(() => p.removePlaylist(PL_ID), isMissingYoutube)
    await assert.rejects(() => p.populatePlaylist(PL_ID, ['dQw4w9WgXcQ'], {}), isMissingYoutube)
    assert.deepStrictEqual(calls, [])
  })
})

test('reads without any YouTube scope name the youtube scope (the one login requests)', async () => {
  const p = providerWithScopes([PROFILE])
  await withEmptyApi(async (calls) => {
    await assert.rejects(() => p.listPlaylists({ limit: 5 }), isMissingYoutube)
    assert.deepStrictEqual(calls, [])
  })
})

test('logout reports deleting only the tokens it deletes', async () => {
  const p = providerWithScopes([YOUTUBE_SCOPE, PROFILE])
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch
  try {
    const result = await p.auth.logout()
    assert.deepStrictEqual(result.deletedData, ['access_token', 'refresh_token'])
  } finally {
    globalThis.fetch = original
  }
})
