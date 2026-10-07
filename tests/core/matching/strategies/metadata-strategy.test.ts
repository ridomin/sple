import { test, describe, beforeEach } from 'node:test'
import * as assert from 'node:assert'
import { MetadataStrategy } from '../../../../src/core/matching/strategies/metadata-strategy.js'
import type { CanonicalTrack, Provider } from '../../../../src/core/provider/provider.js'

describe('MetadataStrategy', () => {
  let strategy: MetadataStrategy
  let mockProvider: Partial<Provider>

  beforeEach(() => {
    strategy = new MetadataStrategy()
    mockProvider = {
      search: async () => ({ items: [] }),
    }
  })

  test('should have priority 3 (lowest)', () => {
    assert.strictEqual(strategy.priority, 3)
  })

  test('should have name "metadata"', () => {
    assert.strictEqual(strategy.name, 'metadata')
  })

  describe('isApplicable', () => {
    test('should be applicable when track has a title', () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        durationMs: 180000,
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'cursor-forward' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'all' as const,
          likedSongs: { read: 'exact' as const, write: false },
          isrcSearchMode: 'none' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      assert.strictEqual(strategy.isApplicable(request), true)
    })

    test('should not be applicable when track has no title', () => {
      const track: CanonicalTrack = {
        title: '',
        artists: ['Artist'],
        album: 'Album',
        durationMs: 180000,
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'cursor-forward' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'all' as const,
          likedSongs: { read: 'exact' as const, write: false },
          isrcSearchMode: 'none' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      assert.strictEqual(strategy.isApplicable(request), false)
    })

    test('should not be applicable when title is null', () => {
      const track: CanonicalTrack = {
        title: null as unknown as string,
        artists: ['Artist'],
        album: 'Album',
        durationMs: 180000,
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'cursor-forward' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'all' as const,
          likedSongs: { read: 'exact' as const, write: false },
          isrcSearchMode: 'none' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      assert.strictEqual(strategy.isApplicable(request), false)
    })
  })

  describe('execute', () => {
    test('should return high-confidence match when metadata match found', async () => {
      const track: CanonicalTrack = {
        title: 'Imagine',
        artists: ['John Lennon'],
        album: 'Imagine',
        durationMs: 183000,
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'cursor-forward' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'all' as const,
          likedSongs: { read: 'exact' as const, write: false },
          isrcSearchMode: 'none' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      mockProvider.search = async () => ({
        items: [
          {
            type: 'track' as const,
            id: 'track123',
            ref: 'spotify:track:456',
            name: 'Imagine',
            track: {
              title: 'Imagine',
              artists: ['John Lennon'],
              album: 'Imagine',
              durationMs: 183000,
              refs: {},
            },
          },
        ],
      })

      const result = await strategy.execute(request, mockProvider as Provider)
      assert.notStrictEqual(result, null)
      assert.ok(result!.confidence >= 0.4, 'Confidence should be >= 0.4')
      assert.ok(result!.confidence > 0.8, 'Confidence should be > 0.8 for perfect match')
      assert.strictEqual(result!.trackRef, 'spotify:track:456')
    })

    test('should return null when candidates score below threshold (0.4)', async () => {
      const track: CanonicalTrack = {
        title: 'Obscure Song Title',
        artists: ['Unknown Artist'],
        album: 'Album',
        durationMs: 180000,
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'cursor-forward' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'all' as const,
          likedSongs: { read: 'exact' as const, write: false },
          isrcSearchMode: 'none' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      mockProvider.search = async () => ({
        items: [
          {
            type: 'track' as const,
            id: 'track456',
            ref: 'spotify:track:789',
            name: 'Completely Different Song',
            track: {
              title: 'Completely Different Song',
              artists: ['Different Artist'],
              album: 'Other Album',
              durationMs: 300000,
              refs: {},
            },
          },
        ],
      })

      const result = await strategy.execute(request, mockProvider as Provider)
      assert.strictEqual(result, null)
    })

    test('should return null when search returns no results', async () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        durationMs: 180000,
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'cursor-forward' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'all' as const,
          likedSongs: { read: 'exact' as const, write: false },
          isrcSearchMode: 'none' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      mockProvider.search = async () => ({ items: [] })

      const result = await strategy.execute(request, mockProvider as Provider)
      assert.strictEqual(result, null)
    })

    test('should propagate search errors to the engine (ADR-0009 A1 §1.4)', async () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        durationMs: 180000,
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'cursor-forward' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'all' as const,
          likedSongs: { read: 'exact' as const, write: false },
          isrcSearchMode: 'none' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      mockProvider.search = async () => {
        throw new Error('Quota exceeded')
      }

      await assert.rejects(() => strategy.execute(request, mockProvider as Provider), /Quota exceeded/)
    })

    test('should include track metadata in the result', async () => {
      const track: CanonicalTrack = {
        title: 'Dream On',
        artists: ['Aerosmith'],
        album: 'Aerosmith',
        durationMs: 345000,
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'cursor-forward' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'all' as const,
          likedSongs: { read: 'exact' as const, write: false },
          isrcSearchMode: 'none' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      mockProvider.search = async () => ({
        items: [
          {
            type: 'track' as const,
            id: 'track789',
            ref: 'spotify:track:789',
            name: 'Dream On',
            track: {
              title: 'Dream On',
              artists: ['Aerosmith'],
              album: 'Aerosmith',
              durationMs: 345000,
              refs: {},
            },
          },
        ],
      })

      const result = await strategy.execute(request, mockProvider as Provider)
      assert.notStrictEqual(result, null)
      assert.strictEqual(result!.metadata.title, 'Dream On')
      assert.deepStrictEqual(result!.metadata.artists, ['Aerosmith'])
      assert.strictEqual(result!.metadata.album, 'Aerosmith')
      assert.strictEqual(result!.metadata.duration, 345000)
    })

    test('should handle search results with non-track items', async () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'cursor-forward' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'all' as const,
          likedSongs: { read: 'exact' as const, write: false },
          isrcSearchMode: 'none' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      // Return album and artist results, no track
      mockProvider.search = async () => ({
        items: [
          {
            type: 'album' as const,
            id: 'album123',
            ref: 'spotify:album:123',
            name: 'Album',
            artists: ['Artist'],
          },
          {
            type: 'artist' as const,
            id: 'artist123',
            ref: 'spotify:artist:123',
            name: 'Artist',
          },
        ],
      })

      const result = await strategy.execute(request, mockProvider as Provider)
      assert.strictEqual(result, null)
    })

    test('should select best match when multiple candidates are returned', async () => {
      const track: CanonicalTrack = {
        title: 'Song Title',
        artists: ['Artist Name'],
        album: 'Album',
        durationMs: 180000,
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'cursor-forward' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'all' as const,
          likedSongs: { read: 'exact' as const, write: false },
          isrcSearchMode: 'none' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      mockProvider.search = async () => ({
        items: [
          {
            type: 'track' as const,
            id: 'track1',
            ref: 'spotify:track:1',
            name: 'Song Title',
            track: {
              title: 'Song Title',
              artists: ['Artist Name'],
              album: 'Album',
              durationMs: 180000,
              refs: {},
            },
          },
          {
            type: 'track' as const,
            id: 'track2',
            ref: 'spotify:track:2',
            name: 'Different Song',
            track: {
              title: 'Different Song',
              artists: ['Different Artist'],
              album: 'Other Album',
              durationMs: 200000,
              refs: {},
            },
          },
        ],
      })

      const result = await strategy.execute(request, mockProvider as Provider)
      assert.notStrictEqual(result, null)
      // Should return the best match (exact match)
      assert.strictEqual(result!.trackRef, 'spotify:track:1')
      assert.ok(result!.confidence > 0.8)
    })
  })
})
