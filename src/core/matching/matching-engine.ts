import type {
  MatchingStrategy,
  MatchRequest,
  MatchResult,
  MatchReport,
} from './types.js'
import type { Provider, CanonicalTrack } from '../provider/provider.js'
import type { ProviderCapabilities } from '../provider/capabilities.js'
import type { CanonicalPlaylistFile, PositionedTrack } from '../export/format.js'
import { KnownRefStrategy } from './strategies/known-ref-strategy.js'
import { IsrcStrategy } from './strategies/isrc-strategy.js'
import { MetadataStrategy } from './strategies/metadata-strategy.js'

/**
 * MatchingEngine orchestrates the three-strategy chain for track matching.
 * Strategies are applied in priority order (1 = highest):
 * 1. Known-ref: Zero API calls, confidence 1.0
 * 2. ISRC: One API call if applicable, confidence 0.95
 * 3. Metadata: Title+artist normalization, confidence 0.4-1.0
 */
export class MatchingEngine {
  private strategies: MatchingStrategy[]

  constructor() {
    // Initialize strategies and sort by priority (lowest number = highest priority)
    this.strategies = [
      new KnownRefStrategy(),
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
    options: { minConfidence?: number; sourceFilePath?: string } = {}
  ): Promise<MatchReport> {
    const minConfidence = options.minConfidence ?? 0.5
    const results: MatchResult[] = []

    // Match each track in the file
    for (const track of file.tracks) {
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
      importedAt: new Date().toISOString(),
      sourceFile: {
        path: options.sourceFilePath ?? '',
        provider: file.source.provider,
        playlistName: file.playlist.name,
        trackCount: file.playlist.trackCount,
      },
      targetProvider: provider.id,
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
    for (const strategy of applicableStrategies) {
      try {
        const candidate = await strategy.execute(request, provider)
        if (candidate) {
          return {
            track: request.track,
            position: request.position,
            status: 'matched',
            candidate,
            confidence: candidate.confidence,
            strategies: [strategy.name],
          }
        }
      } catch (error) {
        // Strategy failed; continue to next strategy
        // Log error in production, but don't abort
        continue
      }
    }

    // No strategy produced a match
    return {
      track: request.track,
      position: request.position,
      status: 'unmatched',
      strategies: applicableStrategies.map((s) => s.name),
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
