import { test } from 'node:test'
import * as assert from 'node:assert'
import { parseSpotifyPlaylistRef } from '../../../src/providers/spotify/playlist-ref.js'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'

const ID = '6UGD4JQwKMz7nVZAKWQaFS'

test('parseSpotifyPlaylistRef', async (t) => {
  const cases: Array<[string, string | null]> = [
    [ID, ID],
    [`  ${ID}\n`, ID],
    [`spotify:playlist:${ID}`, ID],
    [`https://open.spotify.com/playlist/${ID}`, ID],
    [`https://open.spotify.com/playlist/${ID}?si=abc123def456`, ID],
    [`https://open.spotify.com/playlist/${ID}/`, ID],
    [`https://open.spotify.com/intl-de/playlist/${ID}?si=x`, ID],
    [`https://open.spotify.com/intl-pt-BR/playlist/${ID}`, ID],
    [`http://open.spotify.com/playlist/${ID}`, ID],
    // not playlist refs
    ['My Playlist', null],
    ['', null],
    [ID.slice(0, 21), null],
    [`${ID}X`, null],
    ['6UGD4JQwKMz7nVZAKWQa-S', null],
    [`spotify:album:${ID}`, null],
    [`spotify:playlist:${ID}x`, null],
    [`https://open.spotify.com/album/${ID}`, null],
    [`https://example.com/playlist/${ID}`, null],
    [`https://open.spotify.com.evil.com/playlist/${ID}`, null],
    [`ftp://open.spotify.com/playlist/${ID}`, null],
    [`https://open.spotify.com/playlist/${ID}/tracks`, null],
  ]
  for (const [input, expected] of cases) {
    await t.test(JSON.stringify(input), () => {
      assert.strictEqual(parseSpotifyPlaylistRef(input), expected)
    })
  }
})

test('Spotify provider wires parsePlaylistRef and spike capability values', () => {
  const p = createSpotifyProvider('client-id')
  assert.strictEqual(p.parsePlaylistRef(`spotify:playlist:${ID}`), ID)
  assert.strictEqual(p.capabilities.isrcSearchMode, 'filter')
  assert.strictEqual(p.capabilities.playlistItemsAccess, 'owned-or-collaborator')
  assert.strictEqual(p.capabilities.maxSearchPageSize, 10)
})
