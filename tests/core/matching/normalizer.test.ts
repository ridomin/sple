import { test, describe } from 'node:test'
import * as assert from 'node:assert'
import { TrackNormalizer } from '../../../src/core/matching/normalizer.js'

describe('TrackNormalizer', () => {
  describe('normalizeTitle', () => {
    test('should remove (feat. X)', () => {
      const result = TrackNormalizer.normalizeTitle('Song Title (feat. Another Artist)')
      assert.strictEqual(result, 'song title')
    })

    test('should remove (ft. X)', () => {
      const result = TrackNormalizer.normalizeTitle('Song (ft. Artist)')
      assert.strictEqual(result, 'song')
    })

    test('should remove (Remix)', () => {
      const result = TrackNormalizer.normalizeTitle('Song (Remix)')
      assert.strictEqual(result, 'song')
    })

    test('should remove (remix by X)', () => {
      const result = TrackNormalizer.normalizeTitle('Song (remix by Producer)')
      assert.strictEqual(result, 'song')
    })

    test('should remove (cover)', () => {
      const result = TrackNormalizer.normalizeTitle('Song (Cover)')
      assert.strictEqual(result, 'song')
    })

    test('should remove (acoustic)', () => {
      const result = TrackNormalizer.normalizeTitle('Song (Acoustic)')
      assert.strictEqual(result, 'song')
    })

    test('should remove (instrumental)', () => {
      const result = TrackNormalizer.normalizeTitle('Song (Instrumental)')
      assert.strictEqual(result, 'song')
    })

    test('should handle unicode combining characters (NFD normalization)', () => {
      // Café with combining accent and precomposed form should both normalize similarly
      const with_accent = 'Café (Remix)'
      const normalized = TrackNormalizer.normalizeTitle(with_accent)
      // Both forms should normalize to lowercase and remove (Remix)
      assert.ok(normalized.startsWith('caf'))
      assert.ok(!normalized.includes('remix'))
    })

    test('should lowercase all text', () => {
      const result = TrackNormalizer.normalizeTitle('SONG TITLE')
      assert.strictEqual(result, 'song title')
    })

    test('should trim whitespace', () => {
      const result = TrackNormalizer.normalizeTitle('  Song Title  ')
      assert.strictEqual(result, 'song title')
    })

    test('should handle multiple removals', () => {
      const result = TrackNormalizer.normalizeTitle('Song (feat. Artist) (Remix)')
      assert.strictEqual(result, 'song')
    })

    test('should return empty string for empty input', () => {
      assert.strictEqual(TrackNormalizer.normalizeTitle(''), '')
    })

    test('should return empty string for null/undefined input', () => {
      assert.strictEqual(TrackNormalizer.normalizeTitle(null as any), '')
      assert.strictEqual(TrackNormalizer.normalizeTitle(undefined as any), '')
    })

    test('should handle case-insensitive feat. variations', () => {
      const result1 = TrackNormalizer.normalizeTitle('Song (FEAT. Artist)')
      const result2 = TrackNormalizer.normalizeTitle('Song (Feat. Artist)')
      assert.strictEqual(result1, 'song')
      assert.strictEqual(result2, 'song')
    })
  })

  describe('normalizeArtist', () => {
    test('should lowercase artist name', () => {
      const result = TrackNormalizer.normalizeArtist('THE BEATLES')
      assert.strictEqual(result, 'the beatles')
    })

    test('should normalize unicode (NFD)', () => {
      const result = TrackNormalizer.normalizeArtist('Björk')
      assert.ok(result.includes('bj'))
    })

    test('should trim whitespace', () => {
      const result = TrackNormalizer.normalizeArtist('  Artist Name  ')
      assert.strictEqual(result, 'artist name')
    })

    test('should return empty string for empty input', () => {
      assert.strictEqual(TrackNormalizer.normalizeArtist(''), '')
    })

    test('should handle null/undefined input', () => {
      assert.strictEqual(TrackNormalizer.normalizeArtist(null as any), '')
      assert.strictEqual(TrackNormalizer.normalizeArtist(undefined as any), '')
    })
  })

  describe('calculateTitleSimilarity', () => {
    test('should return 1 for identical normalized titles', () => {
      const score = TrackNormalizer.calculateTitleSimilarity('Song Title', 'Song Title')
      assert.strictEqual(score, 1)
    })

    test('should return 1 for titles that normalize to the same thing', () => {
      const score = TrackNormalizer.calculateTitleSimilarity(
        'Song Title (feat. Artist)',
        'Song Title'
      )
      assert.strictEqual(score, 1)
    })

    test('should return partial score for partial match', () => {
      const score = TrackNormalizer.calculateTitleSimilarity('Song Title Extra', 'Song Title')
      assert.ok(score > 0.5 && score < 1)
    })

    test('should return 0 for completely different titles', () => {
      const score = TrackNormalizer.calculateTitleSimilarity('Hello World', 'Goodbye Moon')
      assert.strictEqual(score, 0)
    })

    test('should handle single word titles', () => {
      const score = TrackNormalizer.calculateTitleSimilarity('Song', 'Song')
      assert.strictEqual(score, 1)
    })

    test('should return 0 for empty query', () => {
      const score = TrackNormalizer.calculateTitleSimilarity('', 'Song Title')
      assert.strictEqual(score, 0)
    })

    test('should return 0 for empty candidate', () => {
      const score = TrackNormalizer.calculateTitleSimilarity('Song Title', '')
      assert.strictEqual(score, 0)
    })

    test('should be case-insensitive', () => {
      const score1 = TrackNormalizer.calculateTitleSimilarity('Song Title', 'SONG TITLE')
      const score2 = TrackNormalizer.calculateTitleSimilarity('Song Title', 'song title')
      assert.strictEqual(score1, 1)
      assert.strictEqual(score2, 1)
    })
  })

  describe('calculateArtistSimilarity', () => {
    test('should return 1 when artists match exactly', () => {
      const score = TrackNormalizer.calculateArtistSimilarity(['The Beatles'], ['The Beatles'])
      assert.strictEqual(score, 1)
    })

    test('should return 0 when no artists match', () => {
      const score = TrackNormalizer.calculateArtistSimilarity(['Artist A'], ['Artist B'])
      assert.strictEqual(score, 0)
    })

    test('should return 0.5 for partial artist match', () => {
      const score = TrackNormalizer.calculateArtistSimilarity(
        ['Artist A', 'Artist B'],
        ['Artist B', 'Artist C']
      )
      assert.strictEqual(score, 0.5) // One out of two query artists matches
    })

    test('should handle multiple artists in query', () => {
      const score = TrackNormalizer.calculateArtistSimilarity(
        ['Artist A', 'Artist B', 'Artist C'],
        ['Artist A', 'Artist B']
      )
      // Two out of three query artists match
      assert.ok(Math.abs(score - 2 / 3) < 0.01)
    })

    test('should be case-insensitive', () => {
      const score1 = TrackNormalizer.calculateArtistSimilarity(['The Beatles'], ['the beatles'])
      const score2 = TrackNormalizer.calculateArtistSimilarity(['THE BEATLES'], ['The Beatles'])
      assert.strictEqual(score1, 1)
      assert.strictEqual(score2, 1)
    })

    test('should support substring matching', () => {
      // "Beatles" is contained in "The Beatles"
      const score = TrackNormalizer.calculateArtistSimilarity(['Beatles'], ['The Beatles'])
      assert.strictEqual(score, 1)
    })

    test('should return 0 for empty query artists', () => {
      const score = TrackNormalizer.calculateArtistSimilarity([], ['Artist A'])
      assert.strictEqual(score, 0)
    })

    test('should return 0 for empty candidate artists', () => {
      const score = TrackNormalizer.calculateArtistSimilarity(['Artist A'], [])
      assert.strictEqual(score, 0)
    })

    test('should handle single artist lists', () => {
      const score = TrackNormalizer.calculateArtistSimilarity(['Artist A'], ['Artist A'])
      assert.strictEqual(score, 1)
    })
  })

  describe('isWithinDurationTolerance', () => {
    test('should accept identical durations', () => {
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(180000, 180000), true)
    })

    test('should accept durations within 5 second tolerance', () => {
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(180000, 182000), true) // 180s vs 182s
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(180000, 178000), true) // 180s vs 178s
    })

    test('should accept durations at exact tolerance boundary', () => {
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(180000, 185000), true) // exactly 5s difference
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(180000, 175000), true) // exactly 5s difference
    })

    test('should reject durations outside tolerance', () => {
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(180000, 190000), false) // 180s vs 190s (10s diff)
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(180000, 170000), false) // 180s vs 170s (10s diff)
    })

    test('should accept custom tolerance', () => {
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(180000, 190000, 15000), true) // 10s diff, 15s tolerance
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(180000, 190000, 5000), false) // 10s diff, 5s tolerance
    })

    test('should handle zero durations', () => {
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(0, 0), true)
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(0, 3000), true) // 3s diff, within 5s
      assert.strictEqual(TrackNormalizer.isWithinDurationTolerance(0, 10000), false) // 10s diff, outside 5s
    })
  })

  describe('calculateMetadataConfidence', () => {
    test('should return high confidence for perfect match', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist'],
        180000,
        'Song',
        ['Artist'],
        180000
      )
      assert.ok(confidence > 0.9)
    })

    test('should return lower confidence for title-only match', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist A'],
        180000,
        'Song',
        ['Artist B'],
        180000
      )
      // Title matches (0.5) + no artist match (0) + duration matches (0.15) = 0.65
      assert.ok(confidence > 0.4)
      assert.ok(confidence <= 0.65)
    })

    test('should penalize duration mismatch', () => {
      const confidenceOk = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist'],
        180000,
        'Song',
        ['Artist'],
        180000
      )
      const confidenceBad = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist'],
        180000,
        'Song',
        ['Artist'],
        300000 // 120 second difference
      )
      assert.ok(confidenceOk > confidenceBad)
    })

    test('should apply correct weights', () => {
      // Full match: 1*0.5 + 1*0.35 + 1*0.15 = 1.0
      const fullMatch = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist'],
        180000,
        'Song',
        ['Artist'],
        180000
      )
      assert.strictEqual(fullMatch, 1.0)
    })

    test('should cap confidence at 1.0', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist'],
        180000,
        'Song',
        ['Artist'],
        180000
      )
      assert.ok(confidence <= 1.0)
    })

    test('should handle no artist match', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist A'],
        180000,
        'Song',
        ['Artist B'],
        180000
      )
      // Title 1.0 * 0.5 + Artist 0 * 0.35 + Duration 1 * 0.15 = 0.65
      assert.ok(Math.abs(confidence - 0.65) < 0.01)
    })

    test('should handle title mismatch', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        'Hello',
        ['Artist'],
        180000,
        'Goodbye',
        ['Artist'],
        180000
      )
      // Title 0 * 0.5 + Artist 1.0 * 0.35 + Duration 1 * 0.15 = 0.50
      assert.ok(Math.abs(confidence - 0.50) < 0.01)
    })

    test('should handle duration mismatch only', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist'],
        180000,
        'Song',
        ['Artist'],
        300000 // Outside tolerance
      )
      // Title 1.0 * 0.5 + Artist 1.0 * 0.35 + Duration 0 * 0.15 = 0.85
      assert.ok(Math.abs(confidence - 0.85) < 0.01)
    })

    test('should handle empty artists arrays', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        [],
        180000,
        'Song',
        [],
        180000
      )
      // Title 1.0 * 0.5 + Artist 0 * 0.35 + Duration 1 * 0.15 = 0.65
      assert.ok(Math.abs(confidence - 0.65) < 0.01)
    })

    test('should handle empty title', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        '',
        ['Artist'],
        180000,
        '',
        ['Artist'],
        180000
      )
      // Title 0 * 0.5 + Artist 1.0 * 0.35 + Duration 1 * 0.15 = 0.50
      assert.ok(Math.abs(confidence - 0.50) < 0.01)
    })

    test('should normalize titles and artists in confidence calculation', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        'Song (feat. Someone)',
        ['The Artist'],
        180000,
        'Song',
        ['Artist'],
        180000
      )
      // Both should normalize similarly
      assert.ok(confidence > 0.8)
    })
  })
})
