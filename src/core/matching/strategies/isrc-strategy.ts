import type { MatchingStrategy, MatchCandidate, MatchRequest } from '../types.js'
import type { Provider } from '../../provider/provider.js'

/**
 * ISRC strategy: searches for tracks using their ISRC (International Standard Recording Code).
 * ISRC is a unique identifier for recordings and provides high-confidence matches.
 * Priority 3 - runs after known-ref and cache, before metadata matching.
 */
export class IsrcStrategy implements MatchingStrategy {
  readonly name = 'isrc'
  readonly priority = 3

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

    // The adapter turns the query into its own search syntax (ADR-0003 A2).
    const [first] = await provider.searchTracks({ kind: 'isrc', isrc: track.isrc }, { limit: 5 })
    if (!first) {
      return null
    }

    // ISRC is unambiguous when it's in the file and found by the provider,
    // but the lookup is not infallible, so not 1.0.
    return { ref: first.ref, track: first.track, confidence: 0.95, strategy: 'isrc' }
  }
}
