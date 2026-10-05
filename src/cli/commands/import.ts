import { parseArgs } from 'node:util'
import type { CommandContext } from '../cli.js'
import { EXIT_CODES } from '../exit-codes.js'
import { confirm } from '../input.js'
import { createLogger } from '../log.js'
import { UsageError } from '../../core/provider/errors.js'
import { CanonicalFileReader } from '../../core/import/file-reader.js'
import { MatchingEngine } from '../../core/matching/matching-engine.js'
import { MatchReportWriter } from '../../core/import/match-report-writer.js'
import { PlaylistCreator } from '../../core/import/playlist-creator.js'
import { PlaylistError } from '../../core/import/playlist-errors.js'

const USAGE = 'Usage: sple import <file> [--provider <name>] [--name <name>] [--report <path>] [--min-confidence <score>] [--dry-run] [--yes]'

export const name = 'import'
export const summary = 'Import playlists from files'
export const usage = USAGE

export async function run(ctx: CommandContext, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Import a playlist from a canonical export file (JSON or CSV).
Matches tracks on the target provider using a three-strategy chain
(known ref → ISRC → metadata matching) and creates a new playlist.

Arguments:
  file  Path to canonical export file (.json or .csv)

Options:
  -p, --provider <name>      Target provider (spotify, youtube-music; default: ${ctx.config.provider})
  -n, --name <name>          Name for the imported playlist (default: use source name)
  --report <path>            Save match report to file (detected format: .json or .txt)
  --min-confidence <score>   Minimum confidence for auto-matching (0-1; default: 0.5)
  --dry-run                  Show what would be imported without creating the playlist
  --yes                      Skip confirmation prompt
  --provider <name>          Override global provider for this command
  --json                     With --report: output machine-readable JSON
  --help, -h                 Show this help message

Examples:
  sple import my-playlist.json --provider youtube-music
  sple import export.csv --name "My Music" --report report.txt --yes
  sple import playlist.json --dry-run
  sple import songs.json --min-confidence 0.7
`)
    return EXIT_CODES.SUCCESS
  }

  // Parse arguments
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        provider: { type: 'string', short: 'p' },
        name: { type: 'string', short: 'n' },
        report: { type: 'string' },
        'min-confidence': { type: 'string' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }

  // Extract positionals (file path)
  if (parsed.positionals.length === 0) {
    throw new UsageError(`${USAGE}\n\nNo file provided`)
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError('Only one file can be imported at a time')
  }

  const filePath = parsed.positionals[0]
  const targetProvider = parsed.values.provider || ctx.config.provider
  const playlistName = parsed.values.name
  const reportPath = parsed.values.report
  const dryRun = parsed.values['dry-run'] === true
  const userConfirmedYes = parsed.values.yes === true || ctx.yes

  // Validate min-confidence
  let minConfidence = 0.5
  if (parsed.values['min-confidence']) {
    const score = parseFloat(parsed.values['min-confidence'])
    if (Number.isNaN(score) || score < 0 || score > 1) {
      throw new UsageError('--min-confidence must be a number between 0 and 1')
    }
    minConfidence = score
  }

  // Validate file path
  if (filePath.trim() === '') {
    throw new UsageError('File path cannot be empty')
  }

  // Verify target provider is valid
  if (!ctx.registry.has(targetProvider)) {
    throw new UsageError(`Unknown provider '${targetProvider}'`)
  }

  const log = createLogger('import', ctx)

  try {
    // Step 1: Read the export file
    log.info(`Reading file: ${filePath}`)
    const reader = new CanonicalFileReader()
    let canonicalFile
    try {
      canonicalFile = await reader.readFile(filePath)
    } catch (error) {
      throw new UsageError(
        `Failed to read file: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    // Step 2: Get the target provider
    log.info(`Target provider: ${targetProvider}`)
    const provider = ctx.registry.create(targetProvider, ctx.config)

    // Step 3: Run matching engine
    log.info(`Matching ${canonicalFile.tracks.length} tracks...`)
    const engine = new MatchingEngine()
    const report = await engine.match(canonicalFile, provider, provider.capabilities, {
      minConfidence,
      sourceFilePath: filePath,
    })

    // Set playlist name in report (use provided name or source name)
    report.targetPlaylistName = playlistName || canonicalFile.playlist.name

    // Step 4: Output match report
    log.info(`Match results: ${report.summary.matched} matched, ${report.summary.lowConfidence} low-confidence, ${report.summary.unmatched} unmatched`)

    const writer = new MatchReportWriter()

    if (reportPath) {
      // Write report to file
      const isJsonReport = reportPath.toLowerCase().endsWith('.json')
      if (isJsonReport) {
        await writer.writeJson(report, reportPath)
      } else {
        await writer.writeText(report, reportPath)
      }
      ctx.io.out(`Match report saved to: ${reportPath}`)
    } else {
      // Output report to stdout
      const reportText = await writer.writeText(report)
      ctx.io.out(reportText)
    }

    // Step 5: Check if we should create the playlist
    const successfullyMatched = report.summary.matched + report.summary.lowConfidence
    const successRate = canonicalFile.tracks.length > 0
      ? (successfullyMatched / canonicalFile.tracks.length) * 100
      : 0

    ctx.io.err(`\n${successfullyMatched}/${canonicalFile.tracks.length} tracks ready to import (${Math.round(successRate)}%)`)

    // Prompt for confirmation unless --yes or --dry-run
    let shouldCreatePlaylist = false
    if (dryRun) {
      ctx.io.err('(Dry run mode: playlist was not created)')
    } else {
      const promptText = `Create playlist "${report.targetPlaylistName}" with ${successfullyMatched} matched track(s)?`
      try {
        shouldCreatePlaylist = await confirm(promptText, userConfirmedYes)
      } catch (error) {
        // If confirmation is required but stdin is not a terminal, treat it as cancellation
        if (error instanceof UsageError) {
          ctx.io.err(`Cancelled: ${error.message}`)
          return EXIT_CODES.USAGE_ERROR
        }
        throw error
      }
    }

    if (shouldCreatePlaylist) {
      ctx.io.err(`\nCreating playlist: "${report.targetPlaylistName}"`)

      const creator = new PlaylistCreator()
      try {
        const result = await creator.createPlaylistFromMatches(provider, report, report.targetPlaylistName || canonicalFile.playlist.name)
        ctx.io.err(`✓ Playlist created: ${result.playlistUrl || result.playlistId}`)
        ctx.io.err(`  Tracks added: ${result.tracksAdded}${result.tracksFailed > 0 ? `, Failed: ${result.tracksFailed}` : ''}`)
      } catch (error) {
        if (error instanceof PlaylistError) {
          ctx.io.err(`✗ Playlist creation failed: ${error.message}`)
          return EXIT_CODES.ERROR
        }
        throw error
      }
      return EXIT_CODES.SUCCESS
    }

    return EXIT_CODES.SUCCESS
  } catch (error) {
    if (error instanceof UsageError) {
      throw error
    }
    throw new UsageError(`Import failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
