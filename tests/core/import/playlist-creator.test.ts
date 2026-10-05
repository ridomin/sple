import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlaylistCreator } from '../../../src/core/import/playlist-creator.js'
import { PlaylistError, PlaylistCreationError, PlaylistAddTracksError } from '../../../src/core/import/playlist-errors.js'
import type { MatchReport } from '../../../src/core/matching/types.js'

test('PlaylistCreator', async (t) => {
  let creator: PlaylistCreator
  let mockProvider: any
  let mockReport: MatchReport

  function setupMocks() {
    creator = new PlaylistCreator()
    mockProvider = {
      createPlaylist: (opts: any) => {
        return Promise.resolve({
          id: 'pl-123',
          ref: 'pl-123',
          url: 'https://example.com/pl-123',
          name: 'My Playlist',
          owner: { id: 'user-1' },
          owned: true,
          itemsReadable: true
        })
      },
      populatePlaylist: (ref: string, trackRefs: string[], opts: any) => {
        return Promise.resolve({ added: trackRefs, failed: [] })
      }
    }
    mockReport = {
      importedAt: new Date().toISOString(),
      sourceFile: { path: '/test.json', provider: 'spotify', playlistName: 'Test', trackCount: 4 },
      targetProvider: 'youtube-music',
      results: [
        { status: 'matched', candidate: { trackRef: 'track:1', confidence: 0.95, metadata: {} }, track: { title: 'Song 1', artists: [], album: '', durationMs: 180000, refs: {}, isrc: null }, position: 1 },
        { status: 'matched', candidate: { trackRef: 'track:2', confidence: 0.92, metadata: {} }, track: { title: 'Song 2', artists: [], album: '', durationMs: 180000, refs: {}, isrc: null }, position: 2 },
        { status: 'low-confidence', candidate: { trackRef: 'track:3', confidence: 0.55, metadata: {} }, track: { title: 'Song 3', artists: [], album: '', durationMs: 180000, refs: {}, isrc: null }, position: 3 },
        { status: 'unmatched', track: { title: 'Song 4', artists: [], album: '', durationMs: 180000, refs: {}, isrc: null }, position: 4 }
      ],
      summary: { total: 4, matched: 2, lowConfidence: 1, unmatched: 1, unsupported: 0 }
    }
  }

  await t.test('should create playlist with matched tracks', async () => {
    setupMocks()
    const result = await creator.createPlaylistFromMatches(mockProvider, mockReport, 'My Playlist')

    assert.strictEqual(result.playlistId, 'pl-123')
    assert.strictEqual(result.tracksAdded, 3) // Only matched + low-confidence
    assert.strictEqual(result.tracksFailed, 0)
  })

  await t.test('should report tracks that failed to add', async () => {
    setupMocks()
    mockProvider.populatePlaylist = (ref: string, trackRefs: string[], opts: any) => {
      return Promise.resolve({ added: ['track:1', 'track:2'], failed: [{ ref: 'track:3', error: 'Invalid track' }] })
    }

    const result = await creator.createPlaylistFromMatches(mockProvider, mockReport, 'My Playlist')

    assert.strictEqual(result.tracksAdded, 2)
    assert.strictEqual(result.tracksFailed, 1)
  })

  await t.test('should throw PlaylistCreationError if createPlaylist fails', async () => {
    setupMocks()
    mockProvider.createPlaylist = (opts: any) => {
      return Promise.reject(new Error('Permission denied'))
    }

    await assert.rejects(
      () => creator.createPlaylistFromMatches(mockProvider, mockReport, 'My Playlist'),
      PlaylistCreationError
    )
  })

  await t.test('should skip unmatched tracks', async () => {
    setupMocks()
    let capturedTracks: string[] | null = null
    mockProvider.populatePlaylist = (ref: string, trackRefs: string[], opts: any) => {
      capturedTracks = trackRefs
      return Promise.resolve({ added: trackRefs, failed: [] })
    }

    await creator.createPlaylistFromMatches(mockProvider, mockReport, 'My Playlist')

    assert.ok(capturedTracks !== null)
    assert.ok(!capturedTracks.includes('track:4'))
    assert.strictEqual(capturedTracks.length, 3)
  })

  await t.test('should handle add-tracks failure gracefully', async () => {
    setupMocks()
    mockProvider.populatePlaylist = (ref: string, trackRefs: string[], opts: any) => {
      return Promise.reject(new Error('Quota exceeded'))
    }

    await assert.rejects(
      () => creator.createPlaylistFromMatches(mockProvider, mockReport, 'My Playlist'),
      PlaylistAddTracksError
    )
  })
})
