import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createYouTubeMusicProvider } from '../../../src/providers/youtube-music/index.js'
import { saveTokens } from '../../../src/core/config/token-store.js'
import { UsageError } from '../../../src/core/provider/errors.js'

const MY_CHANNEL = 'UCmine000000000000000000'
const OTHER_CHANNEL = 'UCother00000000000000000'
const MY_PL = 'PLmine0000000000000000000000000000'
const OTHER_PL = 'PLother000000000000000000000000000'

function provider() {
  const dir = mkdtempSync(join(tmpdir(), 'sple-yt-read-'))
  saveTokens('youtube-music', {
    accessToken: 'a', scopes: ['https://www.googleapis.com/auth/youtube'], userId: 'u',
    grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }, dir)
  return createYouTubeMusicProvider('cid', 'secret', dir)
}

const playlist = (id: string, channelId: string) => ({
  id,
  snippet: { title: `title ${id}`, description: '', channelId, channelTitle: 'Channel' },
  contentDetails: { itemCount: 3 },
  status: { privacyStatus: 'public' },
})

const video = (id: string) => ({
  id,
  snippet: { title: `Artist - Song ${id}`, channelTitle: 'ArtistVEVO', publishedAt: '2020-01-01T00:00:00Z', categoryId: '10' },
  contentDetails: { duration: 'PT3M5S' },
})

/** A fake Data API: records each request as `<path>?<params>` and answers from the handlers. */
async function withApi<T>(fn: (calls: URL[]) => Promise<T>): Promise<T> {
  const calls: URL[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    calls.push(url)
    const path = url.pathname.replace('/youtube/v3', '')
    const p = url.searchParams
    if (path === '/search' && p.get('type') === 'playlist') {
      return Response.json({ items: [{ id: { kind: 'youtube#playlist', playlistId: OTHER_PL }, snippet: { title: 'Road trip', channelId: OTHER_CHANNEL, channelTitle: 'Someone' } }], pageInfo: { totalResults: 7 }, nextPageToken: 'NEXT' })
    }
    if (path === '/search' && p.get('type') === 'channel') {
      return Response.json({ items: [{ id: { kind: 'youtube#channel', channelId: OTHER_CHANNEL }, snippet: { title: 'Daft Punk', channelId: OTHER_CHANNEL, channelTitle: 'Daft Punk' } }], pageInfo: { totalResults: 1 } })
    }
    if (path === '/search') {
      return Response.json({ items: [{ id: { kind: 'youtube#video', videoId: 'vid00000001' }, snippet: { title: 't' } }], pageInfo: { totalResults: 1 } })
    }
    if (path === '/videos') return Response.json({ items: (p.get('id') ?? '').split(',').map(video), pageInfo: { totalResults: 1 } })
    if (path === '/channels') return Response.json({ items: [{ id: MY_CHANNEL }], pageInfo: { totalResults: 1 } })
    if (path === '/playlists' && p.get('mine') === 'true') return Response.json({ items: [playlist(MY_PL, MY_CHANNEL)], pageInfo: { totalResults: 1 } })
    if (path === '/playlists') return Response.json({ items: [playlist(p.get('id')!, p.get('id') === MY_PL ? MY_CHANNEL : OTHER_CHANNEL)], pageInfo: { totalResults: 1 } })
    if (path === '/playlistItems' && p.get('playlistId') === 'LM') {
      const first = !p.get('pageToken')
      return Response.json({
        items: [{ snippet: { publishedAt: first ? '2026-10-01T10:00:00Z' : '2026-09-01T10:00:00Z', resourceId: { videoId: first ? 'vid00000001' : 'vid00000002' } }, contentDetails: { videoId: first ? 'vid00000001' : 'vid00000002' } }],
        pageInfo: { totalResults: 2 },
        ...(first ? { nextPageToken: 'P2' } : {}),
      })
    }
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('search --type playlist uses type=playlist and returns playlist items without a videos call', async () => {
  await withApi(async (calls) => {
    const page = await provider().search({ text: 'road trip', type: 'playlist' }, { limit: 5 })
    assert.equal(calls[0].searchParams.get('type'), 'playlist')
    assert.deepStrictEqual(calls.map((c) => c.pathname.replace('/youtube/v3', '')), ['/search'])
    assert.deepStrictEqual(page.items, [{
      type: 'playlist', id: OTHER_PL, ref: OTHER_PL, name: 'Road trip',
      url: `https://www.youtube.com/playlist?list=${OTHER_PL}`,
      owner: { id: OTHER_CHANNEL, displayName: 'Someone' },
    }])
    assert.equal(page.total, 7)
    assert.deepStrictEqual(page.next, { cursor: 'NEXT' })
  })
})

test('search --type artist searches channels', async () => {
  await withApi(async (calls) => {
    const page = await provider().search({ text: 'daft punk', type: 'artist' }, { limit: 5 })
    assert.equal(calls[0].searchParams.get('type'), 'channel')
    assert.deepStrictEqual(page.items, [{
      type: 'artist', id: OTHER_CHANNEL, ref: OTHER_CHANNEL, name: 'Daft Punk',
      url: `https://www.youtube.com/channel/${OTHER_CHANNEL}`,
    }])
  })
})

test('search --type album is a UsageError before any request (the Data API has no albums)', async () => {
  await withApi(async (calls) => {
    await assert.rejects(() => provider().search({ text: 'discovery', type: 'album' }, { limit: 5 }), (e: unknown) => e instanceof UsageError && /album/.test((e as Error).message))
    assert.equal(calls.length, 0)
  })
})

test('search --type track still searches videos', async () => {
  await withApi(async (calls) => {
    const page = await provider().search({ text: 'x', type: 'track' }, { limit: 5 })
    assert.equal(calls[0].searchParams.get('type'), 'video')
    assert.equal(page.items[0].type, 'track')
  })
})

test('listPlaylists: --owned lists mine=true; --followed is empty without a request', async () => {
  await withApi(async (calls) => {
    const p = provider()
    const owned = await p.listPlaylists({ limit: 50 }, 'owned')
    assert.deepStrictEqual(owned.items.map((x) => [x.id, x.owned]), [[MY_PL, true]])
    const all = await p.listPlaylists({ limit: 50 })
    assert.equal(all.items.length, 1)
    const callsBefore = calls.length
    const followed = await p.listPlaylists({ limit: 50 }, 'followed')
    assert.deepStrictEqual(followed, { items: [], total: 0 })
    assert.equal(calls.length, callsBefore)
  })
})

test('getPlaylist marks a playlist owned only when its channel is the user\'s channel', async () => {
  await withApi(async (calls) => {
    const p = provider()
    assert.equal((await p.getPlaylist(MY_PL)).owned, true)
    assert.equal((await p.getPlaylist(OTHER_PL)).owned, false)
    // The user's channel is looked up once.
    assert.equal(calls.filter((c) => c.pathname.endsWith('/channels')).length, 1)
  })
})

test('getLikedTracks reads the LM (Liked Music) playlist page by page, with addedAt from the like time', async () => {
  await withApi(async (calls) => {
    const p = provider()
    const first = await p.getLikedTracks({ limit: 50 })
    const lm = calls.find((c) => c.pathname.endsWith('/playlistItems'))!
    assert.equal(lm.searchParams.get('playlistId'), 'LM')
    assert.equal(first.items.length, 1)
    assert.equal(first.items[0].refs['youtube-music'], 'vid00000001')
    assert.equal(first.items[0].addedAt, '2026-10-01T10:00:00Z')
    assert.equal(first.total, 2)
    assert.deepStrictEqual(first.next, { cursor: 'P2' })
    const second = await p.getLikedTracks({ limit: 50, cursor: 'P2' })
    assert.equal(second.items[0].refs['youtube-music'], 'vid00000002')
    assert.equal(second.next, undefined)
  })
})

test('capabilities: Liked Songs are read exactly from LM (spike S5)', () => {
  assert.deepStrictEqual(provider().capabilities.likedSongs, { read: 'exact', write: false })
})
