import { YouTubeMusicHttpClient } from '../../../src/providers/youtube-music/client.js'
import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import type { HttpClient } from '../../../src/core/http/client.js'

describe('YouTubeMusicHttpClient', () => {
  let client: YouTubeMusicHttpClient
  let mockHttp: jest.Mocked<Partial<HttpClient>>

  beforeEach(() => {
    mockHttp = {
      requestJson: jest.fn(),
      request: jest.fn(),
    }
    client = new YouTubeMusicHttpClient(mockHttp as HttpClient)
  })

  describe('listPlaylists', () => {
    it('should fetch user playlists with pagination', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [
          {
            id: 'pl1',
            snippet: {
              title: 'My Playlist',
              description: 'Test',
              channelTitle: 'Me',
              thumbnails: { high: { url: 'http://example.com/img.jpg' } }
            },
            contentDetails: { itemCount: 5 },
            status: { privacyStatus: 'private' }
          }
        ],
        pageInfo: { totalResults: 1, resultsPerPage: 1 },
        nextPageToken: undefined
      })

      const result = await client.listPlaylists({ limit: 50 })
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('My Playlist')
      expect(result[0].trackCount).toBe(5)
    })

    it('should handle pagination with cursor', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [],
        pageInfo: { totalResults: 100, resultsPerPage: 50 },
        nextPageToken: 'next-token-123'
      })

      const result = await client.listPlaylists({ limit: 50, cursor: 'prev-token' })
      expect(mockHttp.requestJson).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('pageToken=prev-token')
        }),
        expect.any(Function)
      )
    })
  })

  describe('getPlaylist', () => {
    it('should fetch single playlist by ID', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [
          {
            id: 'pl1',
            snippet: {
              title: 'Test Playlist',
              description: 'A test',
              channelTitle: 'Channel',
              thumbnails: { high: { url: 'http://example.com/img.jpg' } }
            },
            contentDetails: { itemCount: 10 },
            status: { privacyStatus: 'public' }
          }
        ],
        pageInfo: { totalResults: 1, resultsPerPage: 1 }
      })

      const result = await client.getPlaylist('https://www.youtube.com/playlist?list=pl1')
      expect(result.name).toBe('Test Playlist')
    })

    it('should throw when playlist not found', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [],
        pageInfo: { totalResults: 0, resultsPerPage: 0 }
      })

      await expect(client.getPlaylist('https://www.youtube.com/playlist?list=invalid')).rejects.toThrow()
    })
  })

  describe('getPlaylistTracks', () => {
    it('should fetch playlist items and resolve video metadata', async () => {
      // First: playlistItems
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [
          {
            id: 'item1',
            snippet: {
              resourceId: { videoId: 'vid1' },
              title: 'Item 1',
              description: '',
              playlistId: 'pl1',
              position: 0,
              publishedAt: '2024-01-01T00:00:00Z'
            },
            contentDetails: { videoId: 'vid1' }
          }
        ],
        pageInfo: { totalResults: 1, resultsPerPage: 1 }
      })

      // Second: videos
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [
          {
            id: 'vid1',
            snippet: {
              title: 'Song Title',
              description: '',
              channelTitle: 'Artist',
              publishedAt: '2024-01-01T00:00:00Z'
            },
            contentDetails: { duration: 'PT3M30S' }
          }
        ],
        pageInfo: { totalResults: 1, resultsPerPage: 1 }
      })

      const result = await client.getPlaylistTracks('https://www.youtube.com/playlist?list=pl1')
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Song Title')
      expect(result[0].durationMs).toBe(210000)
    })

    it('should skip videos that cannot be found', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [
          {
            id: 'item1',
            snippet: {
              resourceId: { videoId: 'vid1' },
              title: 'Item',
              description: '',
              playlistId: 'pl1',
              position: 0,
              publishedAt: '2024-01-01T00:00:00Z'
            },
            contentDetails: { videoId: 'vid1' }
          }
        ],
        pageInfo: { totalResults: 1, resultsPerPage: 1 }
      })

      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [],
        pageInfo: { totalResults: 0, resultsPerPage: 0 }
      })

      const result = await client.getPlaylistTracks('https://www.youtube.com/playlist?list=pl1')
      expect(result).toHaveLength(0)
    })
  })

  describe('searchTracks', () => {
    it('should search and fetch video details', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [{ id: { videoId: 'vid1' }, snippet: { title: 'Song', description: '', channelTitle: 'Artist' } }],
        pageInfo: { totalResults: 1, resultsPerPage: 1 }
      })

      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [
          {
            id: 'vid1',
            snippet: { title: 'Song', description: '', channelTitle: 'Artist', publishedAt: '2024-01-01T00:00:00Z' },
            contentDetails: { duration: 'PT3M30S' }
          }
        ],
        pageInfo: { totalResults: 1, resultsPerPage: 1 }
      })

      const result = await client.searchTracks({ text: 'song query' })
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Song')
    })

    it('should return empty array when no results', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [],
        pageInfo: { totalResults: 0, resultsPerPage: 0 }
      })

      const result = await client.searchTracks({ text: 'nonexistent xyz' })
      expect(result).toEqual([])
    })
  })

  describe('resolveTrack', () => {
    it('should search and return candidates with confidence', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [{ id: { videoId: 'vid1' }, snippet: { title: 'Song', description: '', channelTitle: 'Artist' } }],
        pageInfo: { totalResults: 1, resultsPerPage: 1 }
      })

      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [
          {
            id: 'vid1',
            snippet: { title: 'Song', description: '', channelTitle: 'Artist', publishedAt: '2024-01-01T00:00:00Z' },
            contentDetails: { duration: 'PT3M30S' }
          }
        ],
        pageInfo: { totalResults: 1, resultsPerPage: 1 }
      })

      const result = await client.resolveTrack(
        { title: 'Song', artists: ['Artist'], album: '', durationMs: 210000, refs: {} },
        { maxCandidates: 10 }
      )
      expect(result).toHaveLength(1)
      expect(result[0].confidence).toBeGreaterThan(0)
    })

    it('should return empty array when no matches', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        items: [],
        pageInfo: { totalResults: 0, resultsPerPage: 0 }
      })

      const result = await client.resolveTrack(
        { title: 'Unknown', artists: [], album: '', durationMs: 0, refs: {} },
        { maxCandidates: 10 }
      )
      expect(result).toEqual([])
    })
  })

  describe('createPlaylist', () => {
    it('should create playlist with provided data', async () => {
      mockHttp.requestJson!.mockResolvedValueOnce({
        id: 'new-pl',
        snippet: {
          title: 'New Playlist',
          description: 'Created',
          channelTitle: 'Me'
        },
        status: { privacyStatus: 'private' }
      })

      const result = await client.createPlaylist({
        name: 'New Playlist',
        description: 'Created',
        public: false
      })

      expect(result.name).toBe('New Playlist')
    })
  })

  describe('removePlaylist', () => {
    it('should delete playlist', async () => {
      mockHttp.request!.mockResolvedValueOnce(undefined)

      const result = await client.removePlaylist('https://www.youtube.com/playlist?list=pl1')
      expect(result.action).toBe('deleted')
    })
  })

  describe('populatePlaylist', () => {
    it('should add tracks to playlist one by one', async () => {
      mockHttp.request!.mockResolvedValue(undefined)

      const trackRefs = ['https://www.youtube.com/watch?v=vid1', 'https://www.youtube.com/watch?v=vid2']
      const result = await client.populatePlaylist('https://www.youtube.com/playlist?list=pl1', trackRefs, { skipExisting: false })

      expect(result.added).toHaveLength(2)
      expect(result.failed).toHaveLength(0)
    })

    it('should handle failures', async () => {
      mockHttp.request!.mockRejectedValueOnce(new Error('API error'))

      const trackRefs = ['https://www.youtube.com/watch?v=vid1']
      const result = await client.populatePlaylist('https://www.youtube.com/playlist?list=pl1', trackRefs, { skipExisting: false })

      expect(result.failed).toHaveLength(1)
    })
  })

  describe('duration parsing', () => {
    it('should parse ISO 8601 durations correctly', () => {
      // Access private method for testing
      const parsePrivate = (client as any).parseDuration.bind(client)
      expect(parsePrivate('PT3M30S')).toBe(210000)
      expect(parsePrivate('PT1H2M3S')).toBe(3723000)
      expect(parsePrivate('PT45S')).toBe(45000)
      expect(parsePrivate(undefined)).toBe(0)
      expect(parsePrivate('')).toBe(0)
    })
  })

  describe('error handling', () => {
    it('should throw on invalid playlist URL', async () => {
      await expect(client.getPlaylist('not-a-url')).rejects.toThrow()
    })
  })
})
