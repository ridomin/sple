import { test, describe, beforeEach } from 'node:test'
import * as assert from 'node:assert'
import { IsrcStrategy } from '../../../../src/core/matching/strategies/isrc-strategy.js'
import type { CanonicalTrack, Provider, TrackHit, TrackQuery } from '../../../../src/core/provider/provider.js'

const CAPS = {
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
}

const request = (track: CanonicalTrack) => ({ track, position: 1, targetProvider: 'spotify', capabilities: CAPS })

const hit = (ref: string, track: Partial<CanonicalTrack> & { title: string }): TrackHit => ({
  ref,
  track: { artists: [], refs: {}, ...track },
})

/** A provider whose searchTracks records its calls and returns `hits`. */
function providerReturning(hits: TrackHit[] | Error) {
  const calls: Array<{ query: TrackQuery; opts: { limit: number } }> = []
  const provider = {
    searchTracks: async (query: TrackQuery, opts: { limit: number }) => {
      calls.push({ query, opts })
      if (hits instanceof Error) throw hits
      return hits
    },
  } as unknown as Provider
  return { provider, calls }
}

describe('IsrcStrategy', () => {
  let strategy: IsrcStrategy

  beforeEach(() => {
    strategy = new IsrcStrategy()
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
    const imagine: CanonicalTrack = {
      title: 'Imagine',
      artists: ['John Lennon'],
      album: 'Imagine',
      durationMs: 183000,
      isrc: 'USRC17607839',
      refs: {},
    }

    test('searches by ISRC through searchTracks (core builds no query string)', async () => {
      const { provider, calls } = providerReturning([])
      await strategy.execute(request(imagine), provider)
      assert.deepStrictEqual(calls, [{ query: { kind: 'isrc', isrc: 'USRC17607839' }, opts: { limit: 5 } }])
    })

    test('returns the first hit as a MatchCandidate with confidence 0.95', async () => {
      const first = hit('spotify:track:456', { title: 'Imagine', artists: ['John Lennon'], album: 'Imagine', durationMs: 183000 })
      const { provider } = providerReturning([first, hit('spotify:track:999', { title: 'Imagine (Live)' })])
      const result = await strategy.execute(request(imagine), provider)
      assert.deepStrictEqual(result, { ref: 'spotify:track:456', track: first.track, confidence: 0.95, strategy: 'isrc' })
    })

    test('returns null when there are no hits', async () => {
      const { provider } = providerReturning([])
      assert.strictEqual(await strategy.execute(request(imagine), provider), null)
    })

    test('should propagate search errors to the engine (ADR-0009 A1 §1.4)', async () => {
      const { provider } = providerReturning(new Error('Quota exceeded'))
      await assert.rejects(() => strategy.execute(request(imagine), provider), /Quota exceeded/)
    })

    test('returns null without searching when the track has no ISRC', async () => {
      const { provider, calls } = providerReturning([hit('x', { title: 'Imagine' })])
      assert.strictEqual(await strategy.execute(request({ ...imagine, isrc: undefined }), provider), null)
      assert.strictEqual(calls.length, 0)
    })
  })
})
