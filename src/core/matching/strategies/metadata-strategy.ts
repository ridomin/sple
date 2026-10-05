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

    try {
      // Build search query: "Title Artist"
      const query = this.buildSearchQuery(track)

      // Search with limit of 10 candidates to score
      const results = await provider.search({ text: query, type: 'track' }, { limit: 10 })

      if (!results.items || results.items.length === 0) {
        return null
      }

      // Filter for track items only
      const trackItems = results.items.filter((item) => item.type === 'track')
      if (trackItems.length === 0) {
        return null
      }

      // Score each result and return the best match
      let bestCandidate: MatchCandidate | null = null
      let bestScore = 0

      for (const item of trackItems) {
        if (item.type !== 'track') {
          continue
        }

        const score = TrackNormalizer.calculateMetadataConfidence(
          track.title,
          track.artists,
          track.durationMs ?? 0,
          item.track.title,
          item.track.artists,
          item.track.durationMs ?? 0
        )

        if (score > bestScore) {
          bestScore = score
          bestCandidate = {
            trackRef: item.ref,
            confidence: score,
            metadata: {
              title: item.track.title,
              artists: item.track.artists,
              album: item.track.album,
              duration: item.track.durationMs,
            },
          }
        }
      }

      // Only return if confidence is above threshold (0.4)
      // Below 0.4 is too risky for automatic matching
      if (bestCandidate && bestScore >= 0.4) {
        return bestCandidate
      }

      return null
    } catch (error) {
      // Search might fail due to quota, permission, network issues, etc.
      // Return null to fall through to next strategy
      return null
    }
  }

  private buildSearchQuery(track: { title: string; artists: string[] }): string {
    // Build a query: "Title Artist" using primary artist if available
    const artists = track.artists && track.artists.length > 0 ? track.artists[0] : ''
    return [track.title, artists].filter(Boolean).join(' ')
  }
}
