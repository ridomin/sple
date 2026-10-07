import { test, describe, beforeEach } from 'node:test'
import * as assert from 'node:assert'
import { MetadataStrategy } from '../../../../src/core/matching/strategies/metadata-strategy.js'
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

describe('MetadataStrategy', () => {
  let strategy: MetadataStrategy

  beforeEach(() => {
    strategy = new MetadataStrategy()
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
    const imagine: CanonicalTrack = {
      title: 'Imagine',
      artists: ['John Lennon'],
      album: 'Imagine',
      durationMs: 183000,
      refs: {},
    }

    test('searches by metadata through searchTracks (core builds no query string)', async () => {
      const { provider, calls } = providerReturning([])
      await strategy.execute(request(imagine), provider)
      assert.deepStrictEqual(calls, [
        {
          query: { kind: 'metadata', title: 'Imagine', artists: ['John Lennon'], album: 'Imagine', durationMs: 183000 },
          opts: { limit: 10 },
        },
      ])
    })

    test('returns a matching hit as a MatchCandidate', async () => {
      const exact = hit('spotify:track:456', { title: 'Imagine', artists: ['John Lennon'], album: 'Imagine', durationMs: 183000 })
      const { provider } = providerReturning([exact])
      const result = await strategy.execute(request(imagine), provider)
      assert.notStrictEqual(result, null)
      assert.strictEqual(result!.ref, 'spotify:track:456')
      assert.strictEqual(result!.track, exact.track)
      assert.strictEqual(result!.strategy, 'metadata')
      assert.ok(result!.confidence > 0.8, 'Confidence should be > 0.8 for a perfect match')
    })

    test('picks the best-scoring hit', async () => {
      const other = hit('spotify:track:1', { title: 'Something Else', artists: ['Someone'], durationMs: 300000 })
      const exact = hit('spotify:track:2', { title: 'Imagine', artists: ['John Lennon'], durationMs: 183000 })
      const { provider } = providerReturning([other, exact])
      assert.strictEqual((await strategy.execute(request(imagine), provider))!.ref, 'spotify:track:2')
    })

    test('returns null when every hit scores below 0.4', async () => {
      const { provider } = providerReturning([
        hit('spotify:track:789', { title: 'Completely Different Song', artists: ['Different Artist'], durationMs: 300000 }),
      ])
      const track = { title: 'Obscure Song Title', artists: ['Unknown Artist'], durationMs: 120000, refs: {} }
      assert.strictEqual(await strategy.execute(request(track), provider), null)
    })

    test('never returns a hit whose title shares nothing with the source (#25)', async () => {
      const { provider } = providerReturning([
        hit('yt:1', { title: 'Scumbag Millionaire - Attitude (Live in Uddevalla)', artists: ['Scumbag Millionaire'], durationMs: 125000 }),
      ])
      const track = { title: 'Full Speed Go', artists: ['Scumbag Millionaire'], durationMs: 127106, refs: {} }
      assert.strictEqual(await strategy.execute(request(track), provider), null)
    })

    test('never returns a hit by a different artist', async () => {
      const { provider } = providerReturning([hit('x', { title: 'Hallelujah', artists: ['Jeff Buckley'], durationMs: 280000 })])
      const track = { title: 'Hallelujah', artists: ['Leonard Cohen'], durationMs: 280000, refs: {} }
      assert.strictEqual(await strategy.execute(request(track), provider), null)
    })

    test('on a tie the earlier hit wins', async () => {
      const { provider } = providerReturning([
        hit('first', { title: 'Imagine', artists: ['John Lennon'], durationMs: 183000 }),
        hit('second', { title: 'Imagine', artists: ['John Lennon'], durationMs: 183000 }),
      ])
      assert.strictEqual((await strategy.execute(request(imagine), provider))!.ref, 'first')
    })

    test('returns null when there are no hits', async () => {
      const { provider } = providerReturning([])
      assert.strictEqual(await strategy.execute(request(imagine), provider), null)
    })

    test('should propagate search errors to the engine (ADR-0009 A1 §1.4)', async () => {
      const { provider } = providerReturning(new Error('Quota exceeded'))
      await assert.rejects(() => strategy.execute(request(imagine), provider), /Quota exceeded/)
    })
  })
})
