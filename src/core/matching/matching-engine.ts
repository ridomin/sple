import type {
  MatchingStrategy,
  MatchRequest,
  MatchResult,
  MatchReport,
} from './types.js'
import type { Provider, CanonicalTrack } from '../provider/provider.js'
import type { ProviderCapabilities } from '../provider/capabilities.js'
import type { CanonicalPlaylistFile } from '../export/format.js'
import { KnownRefStrategy } from './strategies/known-ref-strategy.js'
import { IsrcStrategy } from './strategies/isrc-strategy.js'
import { MetadataStrategy } from './strategies/metadata-strategy.js'
import { CacheStrategy } from './strategies/cache-strategy.js'
import type { MatchCache } from './match-cache.js'
import { isFatalProviderError } from '../provider/errors.js'

/**
 * MatchingEngine orchestrates the strategy chain for track matching.
 * Strategies are applied in priority order (1 = highest):
 * 1. Known-ref: Zero API calls, confidence 1.0
 * 2. Cache: Zero API calls, the cached confidence (only with a match cache)
 * 3. ISRC: One API call if applicable, confidence 0.95
 * 4. Metadata: Title+artist normalization, confidence 0.4-1.0
 */
export class MatchingEngine {
  private strategies: MatchingStrategy[]
  private readonly cache?: MatchCache

  /** With `cache`, searched candidates are stored and reused (ADR 0009 Amendment 2). */
  constructor(options: { cache?: MatchCache } = {}) {
    this.cache = options.cache
    // Initialize strategies and sort by priority (lowest number = highest priority)
    this.strategies = [
      new KnownRefStrategy(),
      ...(options.cache ? [new CacheStrategy(options.cache)] : []),
      new IsrcStrategy(),
      new MetadataStrategy(),
    ].sort((a, b) => a.priority - b.priority)
  }

  /**
   * Match all tracks in a canonical file against a target provider.
   * @param file Canonical playlist file to match
   * @param provider Target provider instance
   * @param capabilities Target provider capabilities
   * @param options Matching options (minConfidence threshold)
   * @returns MatchReport with results and summary
   */
  async match(
    file: CanonicalPlaylistFile,
    provider: Provider,
    capabilities: ProviderCapabilities,
    options: { minConfidence?: number; sourceFilePath?: string; targetPlaylistName?: string } = {}
  ): Promise<MatchReport> {
    const minConfidence = options.minConfidence ?? 0.5
    const results: MatchResult[] = []

    // Match each track in position order (ADR-0009 A1 §1.1)
    const tracks = [...file.tracks].sort((a, b) => a.position - b.position)
    for (const track of tracks) {
      const request: MatchRequest = {
        track,
        position: track.position,
        targetProvider: provider.id,
        capabilities,
      }

      const result = await this.matchTrack(request, provider)

      // Reclassify matched results below minConfidence threshold as low-confidence
      if (result.status === 'matched' && result.confidence !== undefined) {
        if (result.confidence < minConfidence) {
          result.status = 'low-confidence'
        }
      }

      results.push(result)
    }

    // Add unsupported items to results
    for (const unsupportedItem of file.unsupportedItems) {
      results.push({
        track: this.createPlaceholderTrack(unsupportedItem.name ?? 'Unknown'),
        position: unsupportedItem.position,
        status: 'unsupported',
        error: `Unsupported item type: ${unsupportedItem.kind}`,
        strategies: [],
      })
    }

    // Calculate summary statistics
    const summary = {
      total: results.length,
      matched: results.filter((r) => r.status === 'matched').length,
      lowConfidence: results.filter((r) => r.status === 'low-confidence').length,
      unmatched: results.filter((r) => r.status === 'unmatched').length,
      unsupported: results.filter((r) => r.status === 'unsupported').length,
    }

    // Generate recommendations
    const recommendations: string[] = []
    if (summary.unmatched > 0) {
      recommendations.push(
        `${summary.unmatched} track(s) could not be matched. Check the match report for details.`
      )
    }
    if (summary.lowConfidence > 0) {
      recommendations.push(
        `${summary.lowConfidence} track(s) have low confidence matches. Review and adjust if needed.`
      )
    }
    if (summary.unsupported > 0) {
      recommendations.push(
        `${summary.unsupported} item(s) are not supported on the target provider and will be skipped.`
      )
    }

    return {
      schemaVersion: 1,
      importedAt: new Date().toISOString(),
      sourceFile: {
        path: options.sourceFilePath ?? '',
        provider: file.source.provider,
        playlistName: file.playlist.name,
        trackCount: file.playlist.trackCount,
      },
      targetProvider: provider.id,
      targetPlaylistName: options.targetPlaylistName || file.playlist.name,
      minConfidence,
      results,
      summary,
      recommendations,
    }
  }

  /**
   * Match a single track using the strategy chain.
   * Tries each applicable strategy in priority order until a match is found.
   * @param request Match request for the track
   * @param provider Target provider
   * @returns MatchResult with status, candidate, and confidence
   */
  private async matchTrack(
    request: MatchRequest,
    provider: Provider
  ): Promise<MatchResult> {
    // Filter to applicable strategies
    const applicableStrategies = this.strategies.filter((s) =>
      s.isApplicable(request)
    )

    if (applicableStrategies.length === 0) {
      return {
        track: request.track,
        position: request.position,
        status: 'unmatched',
        error: 'No applicable matching strategies',
        strategies: [],
      }
    }

    // Try each strategy in priority order
    let lastError: string | undefined
    const tried: string[] = []
    for (const strategy of applicableStrategies) {
      tried.push(strategy.name)
      try {
        const candidate = await strategy.execute(request, provider)
        if (candidate) {
          // Saved before the next track, so a later quota stop keeps the searches already spent.
          this.cache?.put(provider.id, request.track, candidate)
          return {
            track: request.track,
            position: request.position,
            status: 'matched',
            candidate,
            confidence: candidate.confidence,
            strategies: tried,
          }
        }
      } catch (error) {
        // ADR-0009 A1 §1.4: these stop the whole run; anything else is recorded
        // and the next strategy runs.
        if (isFatalProviderError(error)) throw error
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    // No strategy produced a match
    return {
      track: request.track,
      position: request.position,
      status: 'unmatched',
      strategies: tried,
      ...(lastError !== undefined && { error: lastError }),
    }
  }

  /**
   * Create a placeholder track for unsupported items (for reporting purposes).
   */
  private createPlaceholderTrack(name: string): CanonicalTrack {
    return {
      title: name,
      artists: [],
      refs: {},
    }
  }
}
