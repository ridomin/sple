import type { MatchingStrategy, MatchCandidate, MatchRequest } from '../types.js'
import type { Provider } from '../../provider/provider.js'
import { TrackNormalizer } from '../normalizer.js'

/**
 * Metadata strategy: searches for tracks using normalized title and artist metadata.
 * This is the lowest-priority (fallback) matching strategy using word-based overlap
 * and confidence scoring without external fuzzy-matching libraries.
 * Priority 3 (lowest) - runs after known-ref and ISRC matching.
 */
export class MetadataStrategy implements MatchingStrategy {
  readonly name = 'metadata'
  readonly priority = 3 // Lowest priority, fallback strategy

  isApplicable(request: MatchRequest): boolean {
    const { track } = request

    // Strategy is applicable if the track has a title
    return track.title !== null && track.title !== undefined && track.title.length > 0
  }

  async execute(request: MatchRequest, provider: Provider): Promise<MatchCandidate | null> {
    const { track } = request

    // The adapter turns the query into its own search syntax (ADR-0003 A2).
    const hits = await provider.searchTracks(
      { kind: 'metadata', title: track.title, artists: track.artists, album: track.album, durationMs: track.durationMs },
      { limit: 10 }
    )

    // Score each result and return the best match
    let bestCandidate: MatchCandidate | null = null
    let bestScore = 0

    for (const hit of hits) {
      const score = TrackNormalizer.calculateMetadataConfidence(
        track.title,
        track.artists,
        track.durationMs ?? 0,
        hit.track.title,
        hit.track.artists,
        hit.track.durationMs ?? 0
      )

      if (score > bestScore) {
        bestScore = score
        bestCandidate = { ref: hit.ref, track: hit.track, confidence: score, strategy: 'metadata' }
      }
    }

    // Only return if confidence is above threshold (0.4)
    // Below 0.4 is too risky for automatic matching
    if (bestCandidate && bestScore >= 0.4) {
      return bestCandidate
    }

    return null
  }
}
