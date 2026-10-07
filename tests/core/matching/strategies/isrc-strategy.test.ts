import { test, describe, beforeEach } from 'node:test'
import * as assert from 'node:assert'
import { IsrcStrategy } from '../../../../src/core/matching/strategies/isrc-strategy.js'
import type { CanonicalTrack, Provider } from '../../../../src/core/provider/provider.js'

describe('IsrcStrategy', () => {
  let strategy: IsrcStrategy
  let mockProvider: Partial<Provider>

  beforeEach(() => {
    strategy = new IsrcStrategy()
    mockProvider = {
      search: async () => ({ items: [] }),
    }
  })

  test('should have priority 2 (medium)', () => {
    assert.strictEqual(strategy.priority, 2)
  })

  test('should have name "isrc"', () => {
    assert.strictEqual(strategy.name, 'isrc')
  })

  describe('isApplicable', () => {
    test('should be applicable when track has ISRC and provider supports ISRC search', () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        durationMs: 180000,
        isrc: 'USRC17607839',
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
          isrcSearchMode: 'lookup' as const,
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

    test('should be applicable with filter mode ISRC search', () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        isrc: 'USRC17607839',
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
          isrcSearchMode: 'filter' as const,
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

    test('should not be applicable when track has no ISRC', () => {
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
          isrcSearchMode: 'lookup' as const,
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

    test('should not be applicable when ISRC is null', () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        isrc: null,
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
          isrcSearchMode: 'lookup' as const,
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

    test('should not be applicable when provider does not support ISRC search', () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        isrc: 'USRC17607839',
        refs: {},
      }

      const request = {
        track,
        position: 1,
        targetProvider: 'youtube-music',
        capabilities: {
          official: true,
          requiresRiskAcknowledgement: false,
          userSuppliedClientId: false,
          requiresClientSecret: true,
          supportsRefreshToken: true,
          supportsRevocation: true,
          paginationModel: 'offset' as const,
          maxSearchPageSize: 50,
          playlistItemsAccess: 'owned-only' as const,
          likedSongs: { read: 'none' as const, write: false },
          isrcSearchMode: 'none' as const, // Does not support ISRC
          searchReturnsDuration: false,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: false,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      assert.strictEqual(strategy.isApplicable(request), false)
    })
  })

  describe('execute', () => {
    test('should return high-confidence match when ISRC search succeeds', async () => {
      const track: CanonicalTrack = {
        title: 'Imagine',
        artists: ['John Lennon'],
        album: 'Imagine',
        durationMs: 183000,
        isrc: 'USRC17607839',
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
          isrcSearchMode: 'lookup' as const,
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
      assert.strictEqual(result!.confidence, 0.95)
      assert.strictEqual(result!.trackRef, 'spotify:track:456')
    })

    test('should return null when ISRC search returns no results', async () => {
      const track: CanonicalTrack = {
        title: 'Unknown Song',
        artists: ['Unknown Artist'],
        isrc: 'INVALIDISRC',
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
          isrcSearchMode: 'lookup' as const,
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
        isrc: 'USRC17607839',
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
          isrcSearchMode: 'lookup' as const,
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
        isrc: 'USIR27800001',
        refs: {},
      }

      const request = {
        track,
        position: 2,
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
          isrcSearchMode: 'lookup' as const,
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
        isrc: 'USRC17607839',
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
          isrcSearchMode: 'lookup' as const,
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

    test('should return null when track has no ISRC', async () => {
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
          isrcSearchMode: 'lookup' as const,
          searchReturnsDuration: true,
          musicAwareSearch: true,
          canDeletePlaylist: true,
          supportsCollaborative: true,
          maxTracksPerRequest: 100,
          quotaModel: { kind: 'rate-limited' as const },
        },
      }

      const result = await strategy.execute(request, mockProvider as Provider)
      assert.strictEqual(result, null)
    })
  })
})
