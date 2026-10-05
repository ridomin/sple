import type { MatchingStrategy, MatchCandidate, MatchRequest } from '../types.js'
import type { Provider } from '../../provider/provider.js'

/**
 * ISRC strategy: searches for tracks using their ISRC (International Standard Recording Code).
 * ISRC is a unique identifier for recordings and provides high-confidence matches.
 * Medium priority (2) - runs after known-ref but before metadata matching.
 */
export class IsrcStrategy implements MatchingStrategy {
  readonly name = 'isrc'
  readonly priority = 2 // Medium priority

  isApplicable(request: MatchRequest): boolean {
    const { track, capabilities } = request

    // Strategy is applicable if:
    // 1. The track has an ISRC
    // 2. The target provider supports ISRC search (lookup or filter mode)
    const supportsIsrcSearch = capabilities.isrcSearchMode !== 'none'
    const hasIsrc = track.isrc !== null && track.isrc !== undefined

    return hasIsrc && supportsIsrcSearch
  }

  async execute(request: MatchRequest, provider: Provider): Promise<MatchCandidate | null> {
    const { track } = request

    if (!track.isrc) {
      return null
    }

    try {
      // Search by ISRC
      // Most providers accept ISRC in search queries
      const results = await provider.search(
        { text: `isrc:${track.isrc}`, type: 'track' },
        { limit: 5 }
      )

      if (!results.items || results.items.length === 0) {
        return null
      }

      // Find the first track item (filter out non-track search results)
      const trackItem = results.items.find((item) => item.type === 'track')
      if (!trackItem || trackItem.type !== 'track') {
        return null
      }

      // Return the first (best) result with high confidence
      // ISRC is unambiguous when it's in the file and found by the provider
      return {
        trackRef: trackItem.ref,
        confidence: 0.95, // Near-perfect, but not 1.0 (ISRC lookup is highly reliable but not infallible)
        metadata: {
          title: trackItem.track.title,
          artists: trackItem.track.artists,
          album: trackItem.track.album,
          duration: trackItem.track.durationMs,
        },
      }
    } catch (error) {
      // Search might fail due to quota, permission, network issues, etc.
      // Return null to fall through to next strategy
      return null
    }
  }
}
