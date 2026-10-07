import { test, describe, beforeEach } from 'node:test'
import * as assert from 'node:assert'
import { KnownRefStrategy } from '../../../../src/core/matching/strategies/known-ref-strategy.js'
import type { CanonicalTrack, Provider } from '../../../../src/core/provider/provider.js'

describe('KnownRefStrategy', () => {
  let strategy: KnownRefStrategy
  let mockProvider: Provider

  beforeEach(() => {
    strategy = new KnownRefStrategy()
    // Mock provider - strategies don't actually call provider methods for known-ref
    mockProvider = {} as Provider
  })

  test('should have priority 1 (highest)', () => {
    assert.strictEqual(strategy.priority, 1)
  })

  test('should have name "known-ref"', () => {
    assert.strictEqual(strategy.name, 'known-ref')
  })

  test('should always be applicable', () => {
    const request = {
      track: {
        title: 'Song',
        artists: ['Artist'],
        refs: {},
      } as CanonicalTrack,
      position: 1,
      targetProvider: 'youtube-music',
      capabilities: { paginationModel: 'page-offset', maxTracksPerRequest: 50 },
    }

    assert.strictEqual(strategy.isApplicable(request), true)
  })

  const track: CanonicalTrack = {
    title: 'Song',
    artists: ['Artist'],
    album: 'Album',
    durationMs: 180000,
    refs: {
      spotify: 'spotify:track:123',
      'youtube-music': 'dQw4w9WgXcQ',
    },
  }
  const request = (t: CanonicalTrack, targetProvider = 'youtube-music') => ({
    track: t,
    position: 1,
    targetProvider,
    capabilities: { paginationModel: 'page-offset', maxTracksPerRequest: 50 },
  })

  test('returns the target ref as a MatchCandidate with confidence 1.0 and the source track', async () => {
    const result = await strategy.execute(request(track), mockProvider)
    assert.deepStrictEqual(result, { ref: 'dQw4w9WgXcQ', track, confidence: 1.0, strategy: 'known-ref' })
  })

  test('picks the ref for the target provider', async () => {
    assert.strictEqual((await strategy.execute(request(track, 'spotify'), mockProvider))!.ref, 'spotify:track:123')
  })

  test('returns null when no ref exists for the target provider', async () => {
    assert.strictEqual(await strategy.execute(request({ ...track, refs: { spotify: 'spotify:track:123' } }), mockProvider), null)
  })

  test('returns null when refs is empty', async () => {
    assert.strictEqual(await strategy.execute(request({ ...track, refs: {} }), mockProvider), null)
  })
})
