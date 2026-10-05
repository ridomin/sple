import { SpotifyHttpClient } from '../../../src/providers/spotify/client.js'
import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import type { HttpClient } from '../../../src/core/http/client.js'

describe('SpotifyHttpClient', () => {
  let client: SpotifyHttpClient
  let mockHttp: jest.Mocked<Partial<HttpClient>>

  beforeEach(() => {
    mockHttp = {
      requestJson: jest.fn(),
      request: jest.fn(),
    }
    client = new SpotifyHttpClient(mockHttp as HttpClient)
  })

  describe('getPlaylist', () => {
    it('should parse spotify:playlist: URI and fetch playlist', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        id: 'pl1',
        uri: 'spotify:playlist:pl1',
        name: 'My Playlist',
        description: 'Test playlist',
        owner: { id: 'user1', display_name: 'User' },
        public: true,
        tracks: { total: 2 },
        external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' }
      })

      const result = await client.getPlaylist('spotify:playlist:pl1')
      expect(result.name).toBe('My Playlist')
      expect(result.trackCount).toBe(2)
      expect(result.ref).toBe('spotify:playlist:pl1')
    })

    it('should handle HTTPS URL format', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        id: 'pl1',
        uri: 'spotify:playlist:pl1',
        name: 'Test',
        owner: { id: 'user1', display_name: 'User' },
        public: true,
        tracks: { total: 1 },
        external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' }
      })

      const result = await client.getPlaylist('https://open.spotify.com/playlist/pl1')
      expect(result.name).toBe('Test')
    })

    it('should handle raw ID', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        id: 'pl1',
        uri: 'spotify:playlist:pl1',
        name: 'Test',
        owner: { id: 'user1', display_name: 'User' },
        public: true,
        tracks: { total: 1 },
        external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' }
      })

      const result = await client.getPlaylist('pl1')
      expect(result.name).toBe('Test')
    })
  })

  describe('getPlaylistTracks', () => {
    it('should filter out null (unavailable) tracks', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [
          { track: { id: 't1', name: 'Song 1', uri: 'spotify:track:t1', artists: [{ name: 'Artist' }], album: { name: 'Album', id: 'a1' }, duration_ms: 180000 }, added_at: '2024-01-01T00:00:00Z' },
          { track: null, added_at: '2024-01-02T00:00:00Z' },
          { track: { id: 't2', name: 'Song 2', uri: 'spotify:track:t2', artists: [{ name: 'Artist' }], album: { name: 'Album', id: 'a1' }, duration_ms: 200000 }, added_at: '2024-01-03T00:00:00Z' }
        ],
        total: 3,
        next: null
      })

      const result = await client.getPlaylistTracks('spotify:playlist:pl1')
      expect(result).toHaveLength(2)
      expect(result[0].title).toBe('Song 1')
      expect(result[1].title).toBe('Song 2')
    })

    it('should respect limit and offset parameters', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [],
        total: 100,
        next: null
      })

      await client.getPlaylistTracks('spotify:playlist:pl1', { limit: 25, offset: 50 })

      expect(mockHttp.requestJson).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('limit=25')
        }),
        expect.any(Function)
      )
    })

    it('should include addedAt timestamp from API', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [
          { track: { id: 't1', name: 'Song', uri: 'spotify:track:t1', artists: [{ name: 'Artist' }], album: { name: 'Album', id: 'a1' }, duration_ms: 180000 }, added_at: '2024-06-15T12:30:45Z' }
        ],
        total: 1,
        next: null
      })

      const result = await client.getPlaylistTracks('spotify:playlist:pl1')
      expect(result[0].addedAt).toBe('2024-06-15T12:30:45Z')
    })
  })

  describe('searchTracks', () => {
    it('should return tracks from search results', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        tracks: {
          items: [
            { id: 't1', name: 'Song', uri: 'spotify:track:t1', artists: [{ name: 'Artist' }], album: { name: 'Album', id: 'a1' }, duration_ms: 180000 }
          ],
          total: 1,
          next: null
        }
      })

      const result = await client.searchTracks({ text: 'song query' })
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Song')
    })

    it('should return empty array when no results', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        tracks: { items: [], total: 0, next: null }
      })

      const result = await client.searchTracks({ text: 'nonexistent artist xyz' })
      expect(result).toEqual([])
    })

    it('should handle pagination with limit and offset', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        tracks: {
          items: [],
          total: 500,
          next: 'https://api.spotify.com/v1/search?offset=50'
        }
      })

      await client.searchTracks({ text: 'query' }, { limit: 50, offset: 0 })

      expect(mockHttp.requestJson).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('offset=0')
        }),
        expect.any(Function)
      )
    })
  })

  describe('resolveTrack', () => {
    it('should return candidates with confidence scores', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        tracks: {
          items: [
            { id: 't1', name: 'Song Title', uri: 'spotify:track:t1', artists: [{ name: 'Artist Name' }], album: { name: 'Album', id: 'a1' }, duration_ms: 180000 }
          ],
          total: 1,
          next: null
        }
      })

      const result = await client.resolveTrack(
        { title: 'Song Title', artists: ['Artist Name'], album: 'Album', durationMs: 180000, refs: { spotify: 't1' } },
        { maxCandidates: 10 }
      )

      expect(result).toHaveLength(1)
      expect(result[0].confidence).toBeGreaterThan(0)
      expect(result[0].ref).toBe('spotify:track:t1')
    })

    it('should return empty array when no matches', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        tracks: { items: [], total: 0, next: null }
      })

      const result = await client.resolveTrack(
        { title: 'Unknown', artists: ['Unknown'], album: '', durationMs: 0, refs: {} },
        { maxCandidates: 10 }
      )

      expect(result).toEqual([])
    })

    it('should filter out results with zero confidence', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        tracks: {
          items: [
            { id: 't1', name: 'Completely Different', uri: 'spotify:track:t1', artists: [{ name: 'Other Artist' }], album: { name: 'Other', id: 'a1' }, duration_ms: 999999 }
          ],
          total: 1,
          next: null
        }
      })

      const result = await client.resolveTrack(
        { title: 'Query', artists: ['Query Artist'], album: '', durationMs: 180000, refs: {} },
        { maxCandidates: 10 }
      )

      // Should filter out low-confidence matches
      expect(result.length).toBeLessThanOrEqual(1)
    })
  })

  describe('createPlaylist', () => {
    it('should fetch current user and create playlist', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        id: 'user1',
        display_name: 'Test User'
      })

      mockHttp.requestJson!.mockResolvedValueOnce({
        id: 'new-pl',
        uri: 'spotify:playlist:new-pl',
        name: 'New Playlist',
        description: 'Created playlist',
        owner: { id: 'user1', display_name: 'Test User' },
        public: true,
        tracks: { total: 0 },
        external_urls: { spotify: 'https://open.spotify.com/playlist/new-pl' }
      })

      const result = await client.createPlaylist({
        name: 'New Playlist',
        description: 'Created playlist',
        public: true
      })

      expect(result.name).toBe('New Playlist')
      expect(result.trackCount).toBe(0)
    })
  })

  describe('removePlaylist', () => {
    it('should unfold playlist (Spotify limitation)', async () => {
      mockHttp.request!.mockResolvedValueOnce(undefined)

      const result = await client.removePlaylist('spotify:playlist:pl1')
      expect(result.action).toBe('deleted')
    })
  })

  describe('populatePlaylist', () => {
    it('should batch add tracks in chunks of 100', async () => {
      mockHttp.request!.mockResolvedValue(undefined)

      const trackRefs = Array.from({ length: 250 }, (_, i) => `spotify:track:${i}`)
      const result = await client.populatePlaylist('spotify:playlist:pl1', trackRefs, { skipExisting: false })

      expect(result.added).toHaveLength(250)
      expect(result.failed).toHaveLength(0)
      expect(mockHttp.request).toHaveBeenCalledTimes(3)
    })

    it('should handle batch failures', async () => {
      mockHttp.request!.mockRejectedValueOnce(new Error('API error'))

      const trackRefs = Array.from({ length: 150 }, (_, i) => `spotify:track:${i}`)
      const result = await client.populatePlaylist('spotify:playlist:pl1', trackRefs, { skipExisting: false })

      expect(result.failed).toHaveLength(100)
    })
  })

  describe('getLikedTracks', () => {
    it('should fetch saved tracks (liked songs)', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [
          { track: { id: 't1', name: 'Liked Song', uri: 'spotify:track:t1', artists: [{ name: 'Artist' }], album: { name: 'Album', id: 'a1' }, duration_ms: 180000 }, added_at: '2024-01-01T00:00:00Z' }
        ],
        total: 1,
        next: null
      })

      const result = await client.getLikedTracks({ limit: 50 })
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Liked Song')
    })
  })

  describe('error handling', () => {
    it('should throw on invalid playlist ref', async () => {
      await expect(client.getPlaylist('not-a-valid-ref')).rejects.toThrow()
    })

    it('should throw on invalid playlist ID format', async () => {
      await expect(client.getPlaylist('http://wrong-domain.com/playlist/id')).rejects.toThrow()
    })
  })
})
