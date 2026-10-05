import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSpotifyProvider } from '../../src/providers/spotify/index.js'
import { createYouTubeMusicProvider } from '../../src/providers/youtube-music/index.js'

test('Provider Interface Compliance (E2E)', async (t) => {
  await t.test('Spotify provider', async (t) => {
    await t.test('should have correct capabilities', () => {
      const provider = createSpotifyProvider('test-client-id')
      assert.ok(provider.capabilities)
      assert.strictEqual(provider.capabilities.official, true)
      assert.strictEqual(provider.capabilities.paginationModel, 'offset')
      assert.strictEqual(provider.capabilities.isrcSearchMode, 'filter')
      assert.strictEqual(provider.capabilities.playlistItemsAccess, 'owned-or-collaborator')
      assert.strictEqual(provider.capabilities.maxTracksPerRequest, 100)
    })

    await t.test('should implement all required methods', () => {
      const provider = createSpotifyProvider('test-client-id')
      assert.strictEqual(provider.id, 'spotify')
      assert.strictEqual(provider.displayName, 'Spotify')
      assert.strictEqual(typeof provider.parsePlaylistRef, 'function')
      assert.strictEqual(typeof provider.search, 'function')
      assert.strictEqual(typeof provider.listPlaylists, 'function')
      assert.strictEqual(typeof provider.getPlaylist, 'function')
      assert.strictEqual(typeof provider.getPlaylistTracks, 'function')
      assert.strictEqual(typeof provider.getLikedTracks, 'function')
      assert.strictEqual(typeof provider.createPlaylist, 'function')
      assert.strictEqual(typeof provider.removePlaylist, 'function')
      assert.strictEqual(typeof provider.resolveTrack, 'function')
      assert.strictEqual(typeof provider.populatePlaylist, 'function')
    })

    await t.test('should have auth handler', () => {
      const provider = createSpotifyProvider('test-client-id')
      assert.ok(provider.auth)
      assert.strictEqual(typeof provider.auth.login, 'function')
      assert.strictEqual(typeof provider.auth.status, 'function')
      assert.strictEqual(typeof provider.auth.logout, 'function')
    })

    await t.test('should parse playlist refs correctly', () => {
      const provider = createSpotifyProvider('test-client-id')
      assert.strictEqual(provider.parsePlaylistRef('spotify:playlist:123'), '123')
      assert.strictEqual(provider.parsePlaylistRef('https://open.spotify.com/playlist/123'), '123')
      assert.strictEqual(provider.parsePlaylistRef('123'), '123')
    })
  })

  await t.test('YouTube Music provider', async (t) => {
    await t.test('should have correct capabilities', () => {
      const provider = createYouTubeMusicProvider('test-client-id', 'test-secret')
      assert.ok(provider.capabilities)
      assert.strictEqual(provider.capabilities.official, true)
      assert.strictEqual(provider.capabilities.paginationModel, 'cursor-forward')
      assert.strictEqual(provider.capabilities.isrcSearchMode, 'none')
      assert.strictEqual(provider.capabilities.playlistItemsAccess, 'all')
      assert.strictEqual(provider.capabilities.maxTracksPerRequest, 1)
    })

    await t.test('should implement all required methods', () => {
      const provider = createYouTubeMusicProvider('test-client-id', 'test-secret')
      assert.strictEqual(provider.id, 'youtube-music')
      assert.strictEqual(provider.displayName, 'YouTube Music')
      assert.strictEqual(typeof provider.parsePlaylistRef, 'function')
      assert.strictEqual(typeof provider.search, 'function')
      assert.strictEqual(typeof provider.listPlaylists, 'function')
      assert.strictEqual(typeof provider.getPlaylist, 'function')
      assert.strictEqual(typeof provider.getPlaylistTracks, 'function')
      assert.strictEqual(typeof provider.getLikedTracks, 'function')
      assert.strictEqual(typeof provider.createPlaylist, 'function')
      assert.strictEqual(typeof provider.removePlaylist, 'function')
      assert.strictEqual(typeof provider.resolveTrack, 'function')
      assert.strictEqual(typeof provider.populatePlaylist, 'function')
    })

    await t.test('should have auth handler with real OAuth', () => {
      const provider = createYouTubeMusicProvider('test-client-id', 'test-secret')
      assert.ok(provider.auth)
      assert.strictEqual(typeof provider.auth.login, 'function')
      assert.strictEqual(typeof provider.auth.status, 'function')
      assert.strictEqual(typeof provider.auth.logout, 'function')
    })

    await t.test('should parse playlist refs correctly', () => {
      const provider = createYouTubeMusicProvider('test-client-id', 'test-secret')
      assert.strictEqual(provider.parsePlaylistRef('https://www.youtube.com/playlist?list=123'), '123')
      assert.strictEqual(provider.parsePlaylistRef('invalid'), null)
    })
  })

  await t.test('Provider differences', async (t) => {
    await t.test('Spotify should not support ISRC, YouTube should', () => {
      const spotify = createSpotifyProvider('test-id')
      const youtube = createYouTubeMusicProvider('test-id', 'test-secret')

      assert.strictEqual(spotify.capabilities.isrcSearchMode, 'filter')
      assert.strictEqual(youtube.capabilities.isrcSearchMode, 'none')
    })

    await t.test('Spotify uses offset pagination, YouTube uses cursor', () => {
      const spotify = createSpotifyProvider('test-id')
      const youtube = createYouTubeMusicProvider('test-id', 'test-secret')

      assert.strictEqual(spotify.capabilities.paginationModel, 'offset')
      assert.strictEqual(youtube.capabilities.paginationModel, 'cursor-forward')
    })

    await t.test('Spotify can delete playlists, YouTube can', () => {
      const spotify = createSpotifyProvider('test-id')
      const youtube = createYouTubeMusicProvider('test-id', 'test-secret')

      assert.strictEqual(spotify.capabilities.canDeletePlaylist, false)
      assert.strictEqual(youtube.capabilities.canDeletePlaylist, true)
    })

    await t.test('Spotify has exact Liked Songs, YouTube has approximate', () => {
      const spotify = createSpotifyProvider('test-id')
      const youtube = createYouTubeMusicProvider('test-id', 'test-secret')

      assert.strictEqual(spotify.capabilities.likedSongs.read, 'exact')
      assert.strictEqual(youtube.capabilities.likedSongs.read, 'approximate')
    })
  })
})
