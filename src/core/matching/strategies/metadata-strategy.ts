import type { MatchingStrategy, MatchCandidate, MatchRequest } from '../types.js'
import type { Provider } from '../../provider/provider.js'
import { scoreMetadata } from '../normalizer.js'

/**
 * Metadata strategy: searches by title and artists and scores each hit with
 * ADR-0009 A1 §4 (token overlap on normalized title and artists, plus duration).
 * Priority 4 (lowest) - runs after known-ref, cache and ISRC matching.
 */
export class MetadataStrategy implements MatchingStrategy {
  readonly name = 'metadata'
  readonly priority = 4 // Lowest priority, fallback strategy

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

    // ADR-0009 A1 §4: the best accepted hit wins; ties go to the earlier hit.
    let best: MatchCandidate | null = null
    for (const hit of hits) {
      const score = scoreMetadata(track, hit.track)
      if (score.accepted && (!best || score.confidence > best.confidence)) {
        best = { ref: hit.ref, track: hit.track, confidence: score.confidence, strategy: 'metadata' }
      }
    }
    return best
  }
}
