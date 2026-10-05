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

  test('should return high-confidence match when track has known ref for target provider', async () => {
    const track: CanonicalTrack = {
      title: 'Song',
      artists: ['Artist'],
      album: 'Album',
      durationMs: 180000,
      refs: {
        spotify: 'spotify:track:123',
        'youtube-music': 'AAAABBBBCCCC',
      },
    }

    const request = {
      track,
      position: 1,
      targetProvider: 'youtube-music',
      capabilities: { paginationModel: 'page-offset', maxTracksPerRequest: 50 },
    }

    const result = await strategy.execute(request, mockProvider)
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.confidence, 1.0)
    assert.strictEqual(result!.trackRef, 'AAAABBBBCCCC')
  })

  test('should return null when no known ref exists', async () => {
    const track: CanonicalTrack = {
      title: 'Song',
      artists: ['Artist'],
      album: 'Album',
      durationMs: 180000,
      refs: {
        spotify: 'spotify:track:123',
      },
    }

    const request = {
      track,
      position: 1,
      targetProvider: 'youtube-music',
      capabilities: { paginationModel: 'page-offset', maxTracksPerRequest: 50 },
    }

    const result = await strategy.execute(request, mockProvider)
    assert.strictEqual(result, null)
  })

  test('should return null when refs is empty', async () => {
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
      capabilities: { paginationModel: 'page-offset', maxTracksPerRequest: 50 },
    }

    const result = await strategy.execute(request, mockProvider)
    assert.strictEqual(result, null)
  })

  test('should include track metadata in the result', async () => {
    const track: CanonicalTrack = {
      title: 'My Song',
      artists: ['Artist A', 'Artist B'],
      album: 'My Album',
      durationMs: 250000,
      refs: {
        'spotify': 'spotify:track:456',
      },
    }

    const request = {
      track,
      position: 5,
      targetProvider: 'spotify',
      capabilities: { paginationModel: 'page-offset', maxTracksPerRequest: 50 },
    }

    const result = await strategy.execute(request, mockProvider)
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.metadata.title, 'My Song')
    assert.deepStrictEqual(result!.metadata.artists, ['Artist A', 'Artist B'])
    assert.strictEqual(result!.metadata.album, 'My Album')
    assert.strictEqual(result!.metadata.duration, 250000)
  })

  test('should handle multiple provider refs correctly', async () => {
    const track: CanonicalTrack = {
      title: 'Multi-Provider Song',
      artists: ['Artist'],
      refs: {
        spotify: 'spotify:track:111',
        'youtube-music': 'YYYYZZZZxxxx',
        'amazon-music': 'amzn:track:222',
      },
    }

    // Test Spotify lookup
    const spotifyRequest = {
      track,
      position: 1,
      targetProvider: 'spotify',
      capabilities: { paginationModel: 'page-offset', maxTracksPerRequest: 50 },
    }
    const spotifyResult = await strategy.execute(spotifyRequest, mockProvider)
    assert.strictEqual(spotifyResult!.trackRef, 'spotify:track:111')

    // Test YouTube Music lookup
    const youtubeRequest = {
      track,
      position: 1,
      targetProvider: 'youtube-music',
      capabilities: { paginationModel: 'page-offset', maxTracksPerRequest: 50 },
    }
    const youtubeResult = await strategy.execute(youtubeRequest, mockProvider)
    assert.strictEqual(youtubeResult!.trackRef, 'YYYYZZZZxxxx')

    // Test Amazon Music lookup
    const amazonRequest = {
      track,
      position: 1,
      targetProvider: 'amazon-music',
      capabilities: { paginationModel: 'page-offset', maxTracksPerRequest: 50 },
    }
    const amazonResult = await strategy.execute(amazonRequest, mockProvider)
    assert.strictEqual(amazonResult!.trackRef, 'amzn:track:222')
  })
})
