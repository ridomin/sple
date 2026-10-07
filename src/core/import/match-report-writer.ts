import { writeFile } from 'fs/promises'
import type { MatchReport } from '../matching/types.js'

/**
 * Writes match reports in human-readable and JSON formats.
 * Generates summaries, lists unmatched/low-confidence tracks, and saves to files.
 */
export class MatchReportWriter {
  /**
   * Write match report as formatted JSON to a file.
   * Uses 2-space indentation for readability.
   */
  async writeJson(report: MatchReport, path: string): Promise<void> {
    await writeFile(path, JSON.stringify(report, null, 2))
  }

  /**
   * Generate or write a human-readable match report.
   * Includes header, summary with percentages, recommendations, unmatched tracks,
   * and low-confidence matches.
   * If path is provided, writes to file; always returns text.
   */
  async writeText(report: MatchReport, path?: string): Promise<string> {
    const lines: string[] = []

    // Header
    lines.push(`Match Report: ${report.sourceFile.playlistName}`)
    lines.push(`Source: ${report.sourceFile.provider} → Target: ${report.targetProvider}`)
    lines.push(`Imported at: ${report.importedAt}`)
    lines.push('')

    // Summary
    lines.push('Summary')
    lines.push('-------')
    lines.push(`Total tracks:    ${report.summary.total}`)
    lines.push(
      `Matched:         ${report.summary.matched} (${this.percentage(report.summary.matched, report.summary.total)})`
    )
    lines.push(
      `Low confidence:  ${report.summary.lowConfidence} (${this.percentage(report.summary.lowConfidence, report.summary.total)})`
    )
    lines.push(
      `Unmatched:       ${report.summary.unmatched} (${this.percentage(report.summary.unmatched, report.summary.total)})`
    )
    lines.push(
      `Unsupported:     ${report.summary.unsupported} (${this.percentage(report.summary.unsupported, report.summary.total)})`
    )
    lines.push('')

    // Recommendations
    if (report.recommendations && report.recommendations.length > 0) {
      lines.push('Recommendations')
      lines.push('---------------')
      for (const rec of report.recommendations) {
        lines.push(`• ${rec}`)
      }
      lines.push('')
    }

    // Unmatched tracks (highest priority for user review)
    const unmatched = report.results.filter((r) => r.status === 'unmatched')
    if (unmatched.length > 0) {
      lines.push('Unmatched Tracks')
      lines.push('----------------')
      for (const result of unmatched.slice(0, 20)) {
        lines.push(`${result.position}: ${result.track.title} — ${result.track.artists.join(', ')}`)
        if (result.error) {
          lines.push(`   Error: ${result.error}`)
        }
      }
      if (unmatched.length > 20) {
        lines.push(`... and ${unmatched.length - 20} more`)
      }
      lines.push('')
    }

    // Low-confidence matches
    const lowConf = report.results.filter((r) => r.status === 'low-confidence')
    if (lowConf.length > 0) {
      lines.push('Low-Confidence Matches')
      lines.push('---------------------')
      for (const result of lowConf.slice(0, 10)) {
        const cand = result.candidate
        const candTitle = cand?.track.title ?? 'Unknown'
        lines.push(
          `${result.position}: ${result.track.title} → ${candTitle} (${this.percentage(result.confidence ?? 0, 1)})`
        )
      }
      if (lowConf.length > 10) {
        lines.push(`... and ${lowConf.length - 10} more`)
      }
      lines.push('')
    }

    const text = lines.join('\n')

    if (path) {
      await writeFile(path, text)
    }

    return text
  }

  /**
   * Format a percentage value with value/total.
   * Returns "0%" for zero total.
   */
  private percentage(value: number, total: number): string {
    if (total === 0) return '0%'
    return `${Math.round((value / total) * 100)}%`
  }
}
