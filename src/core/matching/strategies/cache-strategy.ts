import type { MatchingStrategy, MatchCandidate, MatchRequest } from '../types.js'
import type { MatchCache } from '../match-cache.js'

/**
 * Cache strategy (ADR 0009 Amendment 2): a candidate an earlier run found by
 * searching, at most 30 days old. No API call; the original confidence is kept.
 */
export class CacheStrategy implements MatchingStrategy {
  readonly name = 'cache'
  readonly priority = 2

  constructor(private readonly cache: MatchCache) {}

  isApplicable(_request: MatchRequest): boolean {
    return true
  }

  async execute(request: MatchRequest): Promise<MatchCandidate | null> {
    return this.cache.get(request.targetProvider, request.track) ?? null
  }
}
