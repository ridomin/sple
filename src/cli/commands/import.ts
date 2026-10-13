import { parseArgs } from 'node:util'
import type { CommandContext } from '../cli.js'
import { EXIT_CODES, formatErrorOutput } from '../exit-codes.js'
import { confirm } from '../input.js'
import { createLogger } from '../log.js'
import { UsageError } from '../../core/provider/errors.js'
import { CanonicalFileReader } from '../../core/import/file-reader.js'
import { MatchingEngine } from '../../core/matching/matching-engine.js'
import { MatchCache } from '../../core/matching/match-cache.js'
import { MatchReportWriter } from '../../core/import/match-report-writer.js'
import { PlaylistCreator } from '../../core/import/playlist-creator.js'
import { PlaylistAddTracksError } from '../../core/import/playlist-errors.js'
import type { MatchReport } from '../../core/matching/types.js'

const USAGE = 'Usage: sple import <file> [--name <name>] [--report <path>] [--min-confidence <0..1>] [--no-cache] [--dry-run] [--yes]'

export const name = 'import'
export const summary = 'Import playlists from files'
export const usage = USAGE

export interface ImportOutput {
  dryRun: boolean
  report: MatchReport
  /** Absent on a dry run. */
  playlist?: { id: string; ref: string; name: string; url?: string }
  added: number
  failed: Array<{ ref: string; error: string }>
}

export interface ImportDeps {
  stdinIsTTY?: boolean
  prompt?: (question: string) => Promise<boolean>
}

/** `round(100 · value / total)`, halves up; 0 when total is 0. */
const percent = (value: number, total: number) => (total === 0 ? 0 : Math.round((100 * value) / total))

/** `sple import` (ADR-0007 Amendment 1, A9). */
export async function run(ctx: CommandContext, args: string[], deps: ImportDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Import a playlist from a canonical export file (JSON or CSV).
Matches tracks on the target provider using a strategy chain
(known ref → match cache → ISRC → metadata matching) and creates a new playlist.
Matches found by searching are kept for 30 days in the match cache, so a
dry run followed by the real import searches only once.

Arguments:
  file  Path to canonical export file (.json or .csv)

Options:
  --name <name>              Name for the imported playlist (default: the file's playlist name)
  --report <path>            Also write the match report to a file (.json → JSON, else text)
  --min-confidence <score>   Minimum confidence for auto-matching (0-1; default: 0.5)
  --no-cache                 Neither reuse nor store matches in the match cache
  --dry-run                  Show what would be imported without creating the playlist
  --yes                      Skip confirmation prompt
  --provider <name>          Target provider (default: ${ctx.config.provider})
  --json                     Print one ImportOutput JSON document
  --quiet                    Print the created playlist ID only
  --help, -h                 Show this help message

Examples:
  sple import my-playlist.json --provider youtube-music
  sple import export.csv --name "My Music" --report report.txt --yes
  sple import playlist.json --dry-run
  sple import songs.json --min-confidence 0.7
`)
    return EXIT_CODES.SUCCESS
  }

  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        name: { type: 'string' },
        report: { type: 'string' },
        'min-confidence': { type: 'string' },
        'no-cache': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
      },
    })
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }

  // 1. Validate flags, and the confirmation rule, before any file read or request.
  if (parsed.positionals.length === 0) {
    throw new UsageError(`${USAGE}\n\nNo file provided`)
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError('Only one file can be imported at a time')
  }
  const filePath = parsed.positionals[0]
  if (filePath.trim() === '') {
    throw new UsageError('File path cannot be empty')
  }

  let minConfidence = 0.5
  if (parsed.values['min-confidence'] !== undefined) {
    const score = Number(parsed.values['min-confidence'])
    if (parsed.values['min-confidence'].trim() === '' || Number.isNaN(score) || score < 0 || score > 1) {
      throw new UsageError('--min-confidence must be a number between 0 and 1')
    }
    minConfidence = score
  }

  const dryRun = parsed.values['dry-run'] === true
  const yes = parsed.values.yes === true || ctx.yes
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true
  if (!dryRun && !yes && !stdinIsTTY) {
    throw new UsageError('Confirmation required but stdin is not a terminal. Use --yes to skip confirmation.')
  }

  const targetProvider = ctx.config.provider
  if (!ctx.registry.has(targetProvider)) {
    throw new UsageError(`Unknown provider '${targetProvider}'`)
  }

  const log = createLogger('import', ctx)

  // 2. Read the file.
  log.info(`Reading file: ${filePath}`)
  const reader = new CanonicalFileReader({
    trackRefParsers: ctx.registry.trackRefParsers(),
    onWarning: (message) => ctx.io.err(message),
  })
  let canonicalFile
  try {
    canonicalFile = await reader.readFile(filePath)
  } catch (error) {
    throw new UsageError(
      `Failed to read file: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  // 3. Match. Auth, quota and rate-limit errors propagate; nothing is created.
  const provider = ctx.registry.create(targetProvider, ctx.config)
  log.info(`Matching ${canonicalFile.tracks.length} tracks on ${targetProvider}`)
  const cache = parsed.values['no-cache'] ? undefined : new MatchCache({ configDir: ctx.config.configDir })
  const report = await new MatchingEngine({ cache }).match(canonicalFile, provider, provider.capabilities, {
    minConfidence,
    sourceFilePath: filePath,
    targetPlaylistName: parsed.values.name,
  })

  // 4. --report: JSON when the path ends in .json, otherwise text.
  const writer = new MatchReportWriter()
  const reportPath = parsed.values.report
  if (reportPath) {
    if (reportPath.toLowerCase().endsWith('.json')) await writer.writeJson(report, reportPath)
    else await writer.writeText(report, reportPath)
    log.info(`Match report written to ${reportPath}`)
  }

  // 5. Result so far: the text report on stdout (table/TSV), counts on stderr.
  const textMode = !ctx.json && !ctx.quiet
  if (textMode) ctx.io.out(await writer.writeText(report))
  const { matched, total, lowConfidence } = report.summary
  ctx.io.err(`${matched}/${total} tracks ready to import (${percent(matched, total)}%)`)
  if (lowConfidence > 0) {
    ctx.io.err(`${lowConfidence} low-confidence match(es) skipped (below --min-confidence ${minConfidence})`)
  }

  const name = report.targetPlaylistName
  const output: ImportOutput = { dryRun, report, added: 0, failed: [] }

  if (dryRun) {
    if (textMode) ctx.io.out(`[dry-run] Would create private playlist "${name}" with ${matched} tracks`)
    if (ctx.json) ctx.io.out(JSON.stringify(output))
    return EXIT_CODES.SUCCESS
  }

  // 6. Confirm (skipped with --yes).
  if (!yes) {
    const prompt = deps.prompt ?? ((q: string) => confirm(q, false))
    if (!(await prompt(`Create playlist "${name}" with ${matched} matched track(s)?`))) {
      ctx.io.err('Aborted; nothing was changed.')
      return EXIT_CODES.ERROR
    }
  }

  // 7. Create the private playlist and add the matched tracks in position order.
  let result
  try {
    result = await new PlaylistCreator().createPlaylistFromMatches(provider, report, name)
  } catch (error) {
    if (error instanceof PlaylistAddTracksError) {
      // The playlist exists; say where, then let the CLI report the provider error and its exit code.
      ctx.io.err(`sple: playlist ${error.playlistUrl ?? error.playlistId} was created, but adding tracks failed`)
      throw error.cause ?? error
    }
    throw error
  }

  const requested = result.tracksAdded + result.tracksFailed
  output.playlist = result.playlist
  output.added = result.tracksAdded
  output.failed = result.failures

  if (ctx.json) ctx.io.out(JSON.stringify(output))
  else if (ctx.quiet) ctx.io.out(result.playlist.id)
  else {
    const url = result.playlist.url ? ` ${result.playlist.url}` : ''
    ctx.io.out(`Created private playlist "${result.playlist.name}" (${result.playlist.id})${url} with ${result.tracksAdded} of ${requested} tracks`)
  }

  if (result.tracksFailed === 0) return EXIT_CODES.SUCCESS

  // ADR-0007 §5: each failed item, then a summary, and exit 1.
  for (const failure of result.failures) {
    ctx.io.err(`sple: failed to add ${failure.ref}: ${failure.error}`)
  }
  const summaryLine = `added ${result.tracksAdded} of ${requested} tracks; ${result.tracksFailed} failed (see above)`
  ctx.io.err(`sple: ${summaryLine}`)
  if (ctx.json) ctx.io.err(formatErrorOutput(new Error(summaryLine), EXIT_CODES.ERROR, 'PartialFailure'))
  return EXIT_CODES.ERROR
}
