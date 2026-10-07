import type { MatchingStrategy, MatchCandidate, MatchRequest } from '../types.js'
import type { Provider } from '../../provider/provider.js'

/**
 * Known-ref strategy: checks if a track already has a known reference for the target provider.
 * This is the highest-priority matching strategy with perfect confidence (1.0).
 * No API calls are made; the known ref is trusted from cache or export file.
 */
export class KnownRefStrategy implements MatchingStrategy {
  readonly name = 'known-ref'
  readonly priority = 1 // Highest priority

  isApplicable(_request: MatchRequest): boolean {
    // This strategy is always applicable
    return true
  }

  async execute(request: MatchRequest, _provider: Provider): Promise<MatchCandidate | null> {
    const { track, targetProvider } = request

    // Check if the track already has a ref for the target provider
    if (track.refs && track.refs[targetProvider]) {
      // For now, assume the known ref is valid (no validation call)
      // In production, a second API call could verify, but we'll trust the cache
      return { ref: track.refs[targetProvider], track, confidence: 1.0, strategy: 'known-ref' }
    }

    return null // No known ref
  }
}
