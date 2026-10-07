import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createYouTubeMusicProvider } from '../../../src/providers/youtube-music/index.js'
import { resolvePlaylist, clearPlaylistCache } from '../../../src/core/playlist-resolver.js'
import { saveTokens } from '../../../src/core/config/token-store.js'
import { NotFoundError } from '../../../src/core/provider/errors.js'

const LONG_ID = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'
const SHORT_ID = 'PLp1fQ2aB3cD4'
const CHANNEL_ID = 'UCabcdefghijklmnopqrstuv'

// Named after the URL of a playlist that does not exist
const URL_NAMED_PLAYLIST = { id: 'PLnamedLikeAUrl0', title: 'https://music.youtube.com/playlist?list=PLmissing0000000' }

/** Playlists the fake YouTube Data API knows about. */
const PLAYLISTS = [
  { id: LONG_ID, title: 'Imported from Spotify' },
  // A name that is also ID-shaped (no spaces, ≥ 13 chars)
  { id: SHORT_ID, title: 'RoadTripMix2026' },
  URL_NAMED_PLAYLIST,
]

function apiPlaylist(p: { id: string; title: string }) {
  return {
    id: p.id,
    snippet: { title: p.title, description: '', channelId: CHANNEL_ID, channelTitle: 'Test Channel' },
    contentDetails: { itemCount: 0 },
    status: { privacyStatus: 'private' },
  }
}

function listResponse(items: unknown[]) {
  return Response.json({ items, pageInfo: { totalResults: items.length, resultsPerPage: 50 } })
}

/** Minimal fake of the YouTube Data API v3 endpoints the provider uses. */
async function fakeYouTubeApi(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input))
  const method = init?.method ?? 'GET'
  const path = url.pathname.replace('/youtube/v3', '')

  if (path === '/playlists' && method === 'GET') {
    if (url.searchParams.get('mine') === 'true') return listResponse(PLAYLISTS.map(apiPlaylist))
    const id = url.searchParams.get('id')
    // The real API returns an empty list (not 404) for unknown IDs
    return listResponse(PLAYLISTS.filter(p => p.id === id).map(apiPlaylist))
  }
  if (path === '/playlists' && method === 'DELETE') {
    const known = PLAYLISTS.some(p => p.id === url.searchParams.get('id'))
    return known ? new Response(null, { status: 204 }) : Response.json({ error: { code: 404 } }, { status: 404 })
  }
  if (path === '/playlistItems' && method === 'GET') {
    return listResponse([])
  }
  // getPlaylist compares the playlist's channel with the user's (owned flag)
  if (path === '/channels' && method === 'GET') {
    return listResponse([{ id: CHANNEL_ID }])
  }
  throw new Error(`unexpected request: ${method} ${url}`)
}

test('YouTube Music playlist resolution', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'sple-yt-resolve-'))
  const originalFetch = globalThis.fetch
  await saveTokens('youtube-music', {
    accessToken: 'test-token',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    userId: 'test-user',
    scopes: ['https://www.googleapis.com/auth/youtube'],
    grantedAt: new Date().toISOString(),
  }, tempDir)
  const provider = createYouTubeMusicProvider('client-id', 'client-secret', tempDir)

  t.beforeEach(() => {
    clearPlaylistCache()
    globalThis.fetch = fakeYouTubeApi as typeof fetch
  })
  t.afterEach(() => { globalThis.fetch = originalFetch })
  t.after(() => rmSync(tempDir, { recursive: true, force: true }))

  for (const input of [
    LONG_ID,
    `https://www.youtube.com/playlist?list=${LONG_ID}`,
    `https://music.youtube.com/playlist?list=${LONG_ID}`,
  ]) {
    await t.test(`resolves ${input}`, async () => {
      const playlist = await resolvePlaylist(provider, input)
      assert.equal(playlist.id, LONG_ID)
      assert.equal(playlist.ref, LONG_ID, 'canonical playlist ref is the bare ID (ADR-0003 §3.1)')
      assert.equal(playlist.name, 'Imported from Spotify')
    })
  }

  await t.test('resolves a short (13-char) playlist ID', async () => {
    const playlist = await resolvePlaylist(provider, SHORT_ID)
    assert.equal(playlist.id, SHORT_ID)
  })

  await t.test('an ID-shaped input that is not an ID falls back to name lookup', async () => {
    const playlist = await resolvePlaylist(provider, 'RoadTripMix2026')
    assert.equal(playlist.id, SHORT_ID)
  })

  await t.test('an unknown ID is NotFoundError', async () => {
    await assert.rejects(resolvePlaylist(provider, 'PLdoesNotExist0000'), NotFoundError)
  })

  await t.test('an unknown URL is NotFoundError, without name lookup', async () => {
    let listed = false
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input instanceof Request ? input.url : input)).searchParams.get('mine') === 'true') listed = true
      return fakeYouTubeApi(input, init)
    }) as typeof fetch
    await assert.rejects(resolvePlaylist(provider, URL_NAMED_PLAYLIST.title), NotFoundError)
    assert.equal(listed, false)
  })

  await t.test('owner.id is the channel ID, not the playlist ID (#32)', async () => {
    const playlist = await resolvePlaylist(provider, LONG_ID)
    assert.equal(playlist.owner.id, CHANNEL_ID)
    assert.equal(playlist.owner.displayName, 'Test Channel')
  })

  await t.test('getPlaylistTracks accepts a bare ID', async () => {
    const page = await provider.getPlaylistTracks(LONG_ID, { limit: 50 })
    assert.deepEqual(page.items, [])
  })

  await t.test('removePlaylist accepts a bare ID', async () => {
    assert.deepEqual(await provider.removePlaylist(LONG_ID), { action: 'deleted' })
  })
})
