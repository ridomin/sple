import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeProvider } from '../../src/providers/fake/index.js'
import { createSpotifyProvider } from '../../src/providers/spotify/index.js'
import { createYouTubeMusicProvider } from '../../src/providers/youtube-music/index.js'
import { resolvePlaylist, clearPlaylistCache } from '../../src/core/playlist-resolver.js'
import type { PageRequest } from '../../src/core/provider/provider.js'

// ADR-0003 Amendment 2: readPageSize is the page size of every read;
// maxTracksPerRequest is the populatePlaylist batch size only.

test('declared readPageSize values (ADR-0003 §5)', () => {
  assert.deepEqual(createSpotifyProvider('cid').capabilities.readPageSize, { playlists: 50, playlistItems: 100, liked: 50 })
  assert.deepEqual(createYouTubeMusicProvider('cid', 's').capabilities.readPageSize, { playlists: 50, playlistItems: 50, liked: 50 })
  assert.deepEqual(new FakeProvider().capabilities.readPageSize, { playlists: 50, playlistItems: 100, liked: 50 })
  assert.deepEqual(
    new FakeProvider({ capabilities: { readPageSize: { playlists: 7, playlistItems: 8, liked: 9 } } }).capabilities.readPageSize,
    { playlists: 7, playlistItems: 8, liked: 9 }
  )
})

test('the playlist resolver lists playlists in pages of readPageSize.playlists', async () => {
  clearPlaylistCache()
  const p = new FakeProvider({
    initialPlaylists: Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1), name: `P${i + 1}`, ownerId: 'fake-user', trackIds: [] })) as any,
    capabilities: { readPageSize: { playlists: 10, playlistItems: 100, liked: 50 } },
  })
  const requests: PageRequest[] = []
  const original = p.listPlaylists.bind(p)
  p.listPlaylists = async (page, filter) => {
    requests.push(page)
    return original(page, filter)
  }
  await resolvePlaylist(p, 'P25')
  assert.deepEqual(requests.map((r) => r.limit), [10, 10, 10])
  clearPlaylistCache()
})
