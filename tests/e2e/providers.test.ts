import { createSpotifyProvider } from '../../src/providers/spotify/index.js'
import { createYouTubeMusicProvider } from '../../src/providers/youtube-music/index.js'
import { describe, it, expect, beforeEach } from '@jest/globals'

describe('Provider Interface Compliance (E2E)', () => {
  describe('Spotify provider', () => {
    it('should have correct capabilities', () => {
      const provider = createSpotifyProvider('test-client-id')
      expect(provider.capabilities).toBeDefined()
      expect(provider.capabilities.official).toBe(true)
      expect(provider.capabilities.paginationModel).toBe('offset')
      expect(provider.capabilities.isrcSearchMode).toBe('filter')
      expect(provider.capabilities.playlistItemsAccess).toBe('owned-or-collaborator')
      expect(provider.capabilities.maxTracksPerRequest).toBe(100)
    })

    it('should implement all required methods', () => {
      const provider = createSpotifyProvider('test-client-id')
      expect(provider.id).toBe('spotify')
      expect(provider.displayName).toBe('Spotify')
      expect(typeof provider.parsePlaylistRef).toBe('function')
      expect(typeof provider.search).toBe('function')
      expect(typeof provider.listPlaylists).toBe('function')
      expect(typeof provider.getPlaylist).toBe('function')
      expect(typeof provider.getPlaylistTracks).toBe('function')
      expect(typeof provider.getLikedTracks).toBe('function')
      expect(typeof provider.createPlaylist).toBe('function')
      expect(typeof provider.removePlaylist).toBe('function')
      expect(typeof provider.resolveTrack).toBe('function')
      expect(typeof provider.populatePlaylist).toBe('function')
    })

    it('should have auth handler', () => {
      const provider = createSpotifyProvider('test-client-id')
      expect(provider.auth).toBeDefined()
      expect(typeof provider.auth.login).toBe('function')
      expect(typeof provider.auth.status).toBe('function')
      expect(typeof provider.auth.logout).toBe('function')
    })

    it('should parse playlist refs correctly', () => {
      const provider = createSpotifyProvider('test-client-id')
      expect(provider.parsePlaylistRef('spotify:playlist:123')).toBe('123')
      expect(provider.parsePlaylistRef('https://open.spotify.com/playlist/123')).toBe('123')
      expect(provider.parsePlaylistRef('123')).toBe('123')
    })
  })

  describe('YouTube Music provider', () => {
    it('should have correct capabilities', () => {
      const provider = createYouTubeMusicProvider('test-client-id', 'test-secret')
      expect(provider.capabilities).toBeDefined()
      expect(provider.capabilities.official).toBe(true)
      expect(provider.capabilities.paginationModel).toBe('cursor-forward')
      expect(provider.capabilities.isrcSearchMode).toBe('none')
      expect(provider.capabilities.playlistItemsAccess).toBe('all')
      expect(provider.capabilities.maxTracksPerRequest).toBe(1)
    })

    it('should implement all required methods', () => {
      const provider = createYouTubeMusicProvider('test-client-id', 'test-secret')
      expect(provider.id).toBe('youtube-music')
      expect(provider.displayName).toBe('YouTube Music')
      expect(typeof provider.parsePlaylistRef).toBe('function')
      expect(typeof provider.search).toBe('function')
      expect(typeof provider.listPlaylists).toBe('function')
      expect(typeof provider.getPlaylist).toBe('function')
      expect(typeof provider.getPlaylistTracks).toBe('function')
      expect(typeof provider.getLikedTracks).toBe('function')
      expect(typeof provider.createPlaylist).toBe('function')
      expect(typeof provider.removePlaylist).toBe('function')
      expect(typeof provider.resolveTrack).toBe('function')
      expect(typeof provider.populatePlaylist).toBe('function')
    })

    it('should have auth handler with real OAuth', () => {
      const provider = createYouTubeMusicProvider('test-client-id', 'test-secret')
      expect(provider.auth).toBeDefined()
      expect(typeof provider.auth.login).toBe('function')
      expect(typeof provider.auth.status).toBe('function')
      expect(typeof provider.auth.logout).toBe('function')
    })

    it('should parse playlist refs correctly', () => {
      const provider = createYouTubeMusicProvider('test-client-id', 'test-secret')
      expect(provider.parsePlaylistRef('https://www.youtube.com/playlist?list=123')).toBe('123')
      expect(provider.parsePlaylistRef('invalid')).toBeNull()
    })
  })

  describe('Provider differences', () => {
    it('Spotify should not support ISRC, YouTube should', () => {
      const spotify = createSpotifyProvider('test-id')
      const youtube = createYouTubeMusicProvider('test-id', 'test-secret')

      expect(spotify.capabilities.isrcSearchMode).toBe('filter')
      expect(youtube.capabilities.isrcSearchMode).toBe('none')
    })

    it('Spotify uses offset pagination, YouTube uses cursor', () => {
      const spotify = createSpotifyProvider('test-id')
      const youtube = createYouTubeMusicProvider('test-id', 'test-secret')

      expect(spotify.capabilities.paginationModel).toBe('offset')
      expect(youtube.capabilities.paginationModel).toBe('cursor-forward')
    })

    it('Spotify can delete playlists, YouTube can', () => {
      const spotify = createSpotifyProvider('test-id')
      const youtube = createYouTubeMusicProvider('test-id', 'test-secret')

      expect(spotify.capabilities.canDeletePlaylist).toBe(false)
      expect(youtube.capabilities.canDeletePlaylist).toBe(true)
    })

    it('Spotify has exact Liked Songs, YouTube has approximate', () => {
      const spotify = createSpotifyProvider('test-id')
      const youtube = createYouTubeMusicProvider('test-id', 'test-secret')

      expect(spotify.capabilities.likedSongs.read).toBe('exact')
      expect(youtube.capabilities.likedSongs.read).toBe('approximate')
    })
  })
})
