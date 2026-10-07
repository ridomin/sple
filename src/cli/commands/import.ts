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
import { RunStore, newRunItem, type RunState } from '../../core/import/run-store.js'
import { matchRunItem, writeRunItem } from '../../core/import/run-steps.js'
import { describeProgress, findRun, printEstimate, resumeHint, stopped } from './run-shared.js'
import type { MatchReport } from '../../core/matching/types.js'
import type { Provider } from '../../core/provider/provider.js'
import type { QuotaEstimate } from '../../core/quota/estimate.js'

const USAGE = `Usage: sple import <file> [--name <name>] [--report <path>] [--min-confidence <0..1>] [--no-cache] [--dry-run] [--yes]
       sple import --resume <runId|last> [--report <path>] [--yes]`

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
  /** Targets with a daily quota only (ADR 0002 Amendment 5). */
  estimate?: QuotaEstimate
}

export interface ImportDeps {
  stdinIsTTY?: boolean
  prompt?: (question: string) => Promise<boolean>
}

/** `round(100 · value / total)`, halves up; 0 when total is 0. */
const percent = (value: number, total: number) => (total === 0 ? 0 : Math.round((100 * value) / total))

/** Flags that only make sense when starting an import. */
const START_ONLY = ['name', 'min-confidence', 'no-cache', 'dry-run'] as const

/** `sple import` (ADR-0007 Amendment 1, A9; resumable runs: Amendment 4). */
export async function run(ctx: CommandContext, args: string[], deps: ImportDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Import a playlist from a canonical export file (JSON or CSV).
Matches tracks on the target provider using a strategy chain
(known ref → match cache → ISRC → metadata matching) and creates a new playlist.
Matches found by searching are kept for 30 days in the match cache, so a
dry run followed by the real import searches only once.

Progress is saved as the import runs. If it stops (quota, rate limit,
expired login, crash), sple prints a run ID; continue with --resume.

Arguments:
  file  Path to canonical export file (.json or .csv)

Options:
  --name <name>              Name for the imported playlist (default: the file's playlist name)
  --report <path>            Also write the match report to a file (.json → JSON, else text)
  --min-confidence <score>   Minimum confidence for auto-matching (0-1; default: 0.5)
  --no-cache                 Neither reuse nor store matches in the match cache
  --dry-run                  Show what would be imported without creating the playlist
  --resume <runId|last>      Continue an interrupted import (on its original provider);
                             "last" picks the most recent one
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
  sple import --resume 20261007-3fa9c1
  sple import --resume last
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
        resume: { type: 'string' },
        yes: { type: 'boolean' },
      },
    })
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }

  const yes = parsed.values.yes === true || ctx.yes
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true
  const store = new RunStore({ configDir: ctx.config.configDir })
  const log = createLogger('import', ctx)

  // 1. Validate flags, and the confirmation rule, before any file read or request.
  const resumeId = parsed.values.resume
  let state: RunState | undefined
  let provider: Provider
  let dryRun = false
  let report: MatchReport
  let estimate: QuotaEstimate | undefined

  if (resumeId !== undefined) {
    if (parsed.positionals.length > 0) throw new UsageError('--resume takes a run ID, not a file')
    for (const flag of START_ONLY) {
      if (parsed.values[flag] !== undefined) throw new UsageError(`--resume cannot be combined with --${flag}`)
    }
    state = findRun(store, 'import', resumeId)
    const item = state.items[0]
    if (item.phase !== 'adding' && !yes && !stdinIsTTY) {
      throw new UsageError('Confirmation required but stdin is not a terminal. Use --yes to skip confirmation.')
    }
    if (!ctx.registry.has(state.target)) {
      throw new UsageError(`Unknown provider '${state.target}'`)
    }
    provider = ctx.registry.create(state.target, ctx.config)
    ctx.io.err(`Resuming import ${state.runId}: "${item.name}" → ${state.target} (${describeProgress(item)})`)
    const cache = state.options.cache ? new MatchCache({ configDir: ctx.config.configDir }) : undefined
    estimate = printEstimate(ctx, provider, state.items, cache, false)
  } else {
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

    dryRun = parsed.values['dry-run'] === true
    if (!dryRun && !yes && !stdinIsTTY) {
      throw new UsageError('Confirmation required but stdin is not a terminal. Use --yes to skip confirmation.')
    }

    const targetProvider = ctx.config.provider
    if (!ctx.registry.has(targetProvider)) {
      throw new UsageError(`Unknown provider '${targetProvider}'`)
    }

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

    provider = ctx.registry.create(targetProvider, ctx.config)
    const cache = parsed.values['no-cache'] ? undefined : new MatchCache({ configDir: ctx.config.configDir })
    const playlistName = parsed.values.name || canonicalFile.playlist.name
    const item = newRunItem(canonicalFile, { name: playlistName, sourceFilePath: filePath })

    // Matching spends quota too, so the estimate comes first, and a run that
    // won't fit in today's quota is confirmed before any request.
    estimate = printEstimate(ctx, provider, [item], cache, dryRun)
    if (estimate && estimate.days > 1 && !dryRun && !yes) {
      const prompt = deps.prompt ?? ((q: string) => confirm(q, false))
      if (!(await prompt('Start anyway?'))) {
        ctx.io.err('Aborted; nothing was changed.')
        return EXIT_CODES.ERROR
      }
    }

    if (dryRun) {
      // 3. Match. Auth, quota and rate-limit errors propagate; nothing is created or saved.
      log.info(`Matching ${canonicalFile.tracks.length} tracks on ${targetProvider}`)
      report = await new MatchingEngine({ cache }).match(canonicalFile, provider, provider.capabilities, {
        minConfidence,
        sourceFilePath: filePath,
        targetPlaylistName: playlistName,
      })
    } else {
      store.prune()
      state = store.create('import', provider.id, { minConfidence, cache: cache !== undefined }, [item])
    }
  }

  if (state) {
    // 3. Match, checkpointing after every track so searches already spent are never repeated.
    const item = state.items[0]
    if (item.phase === 'matching') {
      const cache = state.options.cache ? new MatchCache({ configDir: ctx.config.configDir }) : undefined
      log.info(`Matching ${item.file.tracks.length - item.results.length} tracks on ${state.target}`)
      try {
        await matchRunItem(provider, store, state, item, cache)
      } catch (error) {
        resumeHint(ctx, 'import', state)
        throw error
      }
    }
    report = item.report!
  }

  // 4. --report: JSON when the path ends in .json, otherwise text.
  const writer = new MatchReportWriter()
  const reportPath = parsed.values.report
  if (reportPath) {
    if (reportPath.toLowerCase().endsWith('.json')) await writer.writeJson(report!, reportPath)
    else await writer.writeText(report!, reportPath)
    log.info(`Match report written to ${reportPath}`)
  }

  // 5. Result so far: the text report on stdout (table/TSV), counts on stderr.
  const textMode = !ctx.json && !ctx.quiet
  if (textMode) ctx.io.out(await writer.writeText(report!))
  const { matched, total, lowConfidence } = report!.summary
  ctx.io.err(`${matched}/${total} tracks ready to import (${percent(matched, total)}%)`)
  if (lowConfidence > 0) {
    ctx.io.err(`${lowConfidence} low-confidence match(es) skipped (below --min-confidence ${report!.minConfidence})`)
  }

  const name = report!.targetPlaylistName
  const output: ImportOutput = { dryRun, report: report!, added: 0, failed: [], ...(estimate && { estimate }) }

  if (dryRun || !state) {
    if (textMode) ctx.io.out(`[dry-run] Would create private playlist "${name}" with ${matched} tracks`)
    if (ctx.json) ctx.io.out(JSON.stringify(output))
    return EXIT_CODES.SUCCESS
  }

  const s = state
  const item = s.items[0]

  // 6. Confirm (skipped with --yes, and once the playlist exists).
  if (item.phase === 'matched' && !yes) {
    const prompt = deps.prompt ?? ((q: string) => confirm(q, false))
    if (!(await prompt(`Create playlist "${name}" with ${matched} matched track(s)?`))) {
      store.delete(s.runId)
      ctx.io.err('Aborted; nothing was changed.')
      return EXIT_CODES.ERROR
    }
  }

  // 7. Create the private playlist and add the matched tracks in position order, checkpointing each batch.
  let result
  try {
    result = await writeRunItem(provider, store, s, item)
  } catch (error) {
    throw stopped(ctx, 'import', s, error)
  }
  store.delete(s.runId)

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
