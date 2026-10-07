import { mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { CommandContext } from '../cli.js'
import { EXIT_CODES, formatErrorOutput } from '../exit-codes.js'
import { confirm } from '../input.js'
import { createLogger } from '../log.js'
import { createProgress, type ProgressStream } from '../progress.js'
import type { ErrorInfo } from '../output/types.js'
import { UsageError } from '../../core/provider/errors.js'
import type { Provider } from '../../core/provider/provider.js'
import { collectPages } from '../../core/pagination.js'
import { resolvePlaylist } from '../../core/playlist-resolver.js'
import { LIKED_SONGS_NAME } from '../../core/export/index.js'
import { MatchCache } from '../../core/matching/match-cache.js'
import { MatchingEngine } from '../../core/matching/matching-engine.js'
import { MatchReportWriter } from '../../core/import/match-report-writer.js'
import { RunStore, newRunItem, type RunItem, type RunState } from '../../core/import/run-store.js'
import { matchRunItem, writeRunItem } from '../../core/import/run-steps.js'
import type { MatchReport } from '../../core/matching/types.js'
import type { QuotaEstimate } from '../../core/quota/estimate.js'
import { buildFile, errorInfo, isFatal, partialFailureExitCode, readTracks, slugify, type Source } from './export.js'
import { findRun, printEstimate, resumeHint, stopped } from './run-shared.js'

const USAGE = `Usage: sple migrate --from <provider> --to <provider> (<playlist>… | --all) [--liked] [--name <name>]
                    [--min-confidence <0..1>] [--report <dir>] [--no-cache] [--dry-run] [--yes]
       sple migrate --from <provider> --to <provider> --liked [options]
       sple migrate --resume <runId|last> [--report <dir>] [--yes]`

export const name = 'migrate'
export const summary = 'Migrate playlists between providers'
export const usage = USAGE

/** Flags that only make sense when starting a migration. */
const START_ONLY = ['from', 'to', 'all', 'liked', 'name', 'min-confidence', 'no-cache', 'dry-run'] as const

export interface MigratePlaylistResult {
  source: { kind: 'playlist' | 'liked'; name: string; ref?: string }
  /** Target playlist name. */
  name: string
  summary: MatchReport['summary']
  /** Absent on a dry run. */
  playlist?: { id: string; ref: string; name: string; url?: string }
  added: number
  failed: Array<{ ref: string; error: string }>
  /** Set with `--report <dir>`. */
  reportPath?: string
}

/** `sple migrate --json` (ADR 0007 Amendment 6). */
export interface MigrateOutput {
  dryRun: boolean
  from: string
  to: string
  playlists: MigratePlaylistResult[]
  /** Sources that could not be read; not part of the run. */
  skipped: Array<{ input: string; error: ErrorInfo }>
  estimate?: QuotaEstimate
}

export interface MigrateDeps {
  stdinIsTTY?: boolean
  prompt?: (question: string) => Promise<boolean>
  progressStream?: ProgressStream
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `Liked Songs (from Spotify)`: the default name of a migrated Liked Songs playlist (FR-MIG-1). */
export function likedPlaylistName(source: Pick<Provider, 'displayName'>): string {
  return `${LIKED_SONGS_NAME} (from ${source.displayName})`
}

function sourceOf(item: RunItem): MigratePlaylistResult['source'] {
  return item.file.source.kind === 'liked'
    ? { kind: 'liked', name: LIKED_SONGS_NAME }
    : { kind: 'playlist', name: item.file.playlist.name, ...(item.file.playlist.ref && { ref: item.file.playlist.ref }) }
}

function counts(summary: MatchReport['summary']): string {
  return `${summary.lowConfidence} low-confidence, ${summary.unmatched} unmatched`
}

/** `sple migrate` (FR-MIG-1, ADR 0007 Amendment 6): export → match → import for each source, as one resumable run. */
export async function run(ctx: CommandContext, args: string[], deps: MigrateDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Copy playlists (or your Liked Songs) from one provider to another. Each source
playlist becomes a new private playlist on the target, holding the tracks that
were matched (low-confidence and unmatched tracks are left out). Likes are
never written: --liked creates a playlist named "Liked Songs (from <Source>)".

Progress is saved as the migration runs. If it stops (quota, rate limit,
expired login, crash), sple prints a run ID; continue with --resume.

Arguments:
  playlist  Source playlist ID, URI, URL, or exact name

Options:
  --from <provider>          Source provider
  --to <provider>            Target provider
  --all                      Every playlist in your library that can be read
  --liked                    Your Liked Songs (can be combined with playlists or --all)
  --name <name>              Target playlist name (only with a single source)
  --min-confidence <score>   Minimum confidence for adding a match (0-1; default: 0.5)
  --report <dir>             Write each playlist's JSON match report into <dir>
  --no-cache                 Neither reuse nor store matches in the match cache
  --dry-run                  Match and report only; create nothing
  --resume <runId|last>      Continue an interrupted migration
  --yes                      Skip the confirmation prompt
  --json                     Print one MigrateOutput JSON document
  --quiet                    Print the created playlist IDs only
  --help, -h                 Show this help message

Examples:
  sple migrate --from spotify --to youtube-music "Road trip" --dry-run
  sple migrate --from spotify --to youtube-music --liked
  sple migrate --from spotify --to youtube-music --all --report reports/
  sple migrate --resume last
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
        from: { type: 'string' },
        to: { type: 'string' },
        all: { type: 'boolean' },
        liked: { type: 'boolean' },
        name: { type: 'string' },
        'min-confidence': { type: 'string' },
        report: { type: 'string' },
        'no-cache': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        resume: { type: 'string' },
        yes: { type: 'boolean' },
      },
    })
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
  const v = parsed.values
  const yes = v.yes === true || ctx.yes
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true
  const store = new RunStore({ configDir: ctx.config.configDir })
  const log = createLogger('migrate', ctx)

  // ---- 1. Validate flags (nothing is read or sent yet) ----
  if (v.report !== undefined) {
    if (v.report.trim() === '') throw new UsageError('--report needs a directory')
    const dir = resolve(v.report)
    try {
      statSync(dir)
      if (!isDirectory(dir)) throw new UsageError(`${v.report} is not a directory`)
    } catch (e) {
      if (e instanceof UsageError) throw e
    }
  }

  let state: RunState | undefined
  let target: Provider
  let from: string
  let items: RunItem[]
  let minConfidence: number
  let cache: MatchCache | undefined
  let dryRun = false
  let estimate: QuotaEstimate | undefined
  const skipped: MigrateOutput['skipped'] = []

  if (v.resume !== undefined) {
    if (parsed.positionals.length > 0) throw new UsageError('--resume takes a run ID, not playlists')
    for (const flag of START_ONLY) {
      if (v[flag] !== undefined) throw new UsageError(`--resume cannot be combined with --${flag}`)
    }
    state = findRun(store, 'migrate', v.resume)
    if (!ctx.registry.has(state.target)) throw new UsageError(`Unknown provider '${state.target}'`)
    target = ctx.registry.create(state.target, ctx.config)
    items = state.items
    from = items[0]?.file.source.provider ?? 'unknown'
    minConfidence = state.options.minConfidence
    cache = state.options.cache ? new MatchCache({ configDir: ctx.config.configDir }) : undefined
    const done = items.filter((i) => i.phase === 'done').length
    ctx.io.err(`Resuming migration ${state.runId}: ${items.length} playlists → ${state.target} (${done} done)`)
    estimate = printEstimate(ctx, target, items, cache, false)
  } else {
    if (!v.from || !v.to) throw new UsageError(`${USAGE}\n\n--from and --to are required`)
    for (const id of [v.from, v.to]) {
      if (!ctx.registry.has(id)) throw new UsageError(`Unknown provider '${id}'. Valid providers: ${ctx.registry.list().join(', ')}`)
    }
    if (v.from === v.to) throw new UsageError('--from and --to must be different providers')
    if (parsed.positionals.length === 0 && !v.all && !v.liked) {
      throw new UsageError('Nothing to migrate: pass playlists, --all or --liked')
    }
    if (parsed.positionals.length > 0 && v.all) throw new UsageError('Pass playlists or --all, not both')
    if (parsed.positionals.some((p) => p.trim() === '')) throw new UsageError('Empty playlist argument')
    const singleSource = !v.all && parsed.positionals.length + (v.liked ? 1 : 0) === 1
    if (v.name !== undefined && !singleSource) throw new UsageError('--name needs exactly one source playlist (or --liked alone)')
    if (v.name !== undefined && v.name.trim() === '') throw new UsageError('--name cannot be empty')

    minConfidence = 0.5
    if (v['min-confidence'] !== undefined) {
      const score = Number(v['min-confidence'])
      if (v['min-confidence'].trim() === '' || Number.isNaN(score) || score < 0 || score > 1) {
        throw new UsageError('--min-confidence must be a number between 0 and 1')
      }
      minConfidence = score
    }
    dryRun = v['dry-run'] === true
    if (!dryRun && !yes && !stdinIsTTY) {
      throw new UsageError('Confirmation required but stdin is not a terminal. Use --yes to skip confirmation.')
    }

    from = v.from
    const source = ctx.registry.create(v.from, ctx.config)
    target = ctx.registry.create(v.to, ctx.config)
    cache = v['no-cache'] ? undefined : new MatchCache({ configDir: ctx.config.configDir })

    // ---- 2. Resolve the sources; unreadable ones are skipped like `export` (ADR 0007 §5) ----
    const skipCodes: number[] = []
    const skip = (input: string, error: unknown) => {
      const info = errorInfo(error)
      skipped.push({ input, error: info })
      skipCodes.push(info.exitCode)
      ctx.io.err(`sple: skipped "${input}": ${info.message}`)
    }
    const sources: Source[] = []
    const seen = new Set<string>()
    for (const input of parsed.positionals) {
      try {
        const playlist = await resolvePlaylist(source, input)
        if (seen.has(playlist.id)) continue
        seen.add(playlist.id)
        sources.push({ kind: 'playlist', input, playlist })
      } catch (error) {
        if (error instanceof UsageError || isFatal(error)) throw error
        skip(input, error)
      }
    }
    if (v.all) {
      const { items: all } = await collectPages((page) => source.listPlaylists(page), {
        pageSize: source.capabilities.readPageSize.playlists,
        model: source.capabilities.paginationModel,
      })
      for (const playlist of all) sources.push({ kind: 'playlist', input: playlist.name, playlist })
    }
    if (v.liked) sources.push({ kind: 'liked', input: '--liked' })

    // ---- 3. Read every source before anything is sent to the target ----
    let userId: string | undefined
    try {
      userId = (await source.auth.status()).user?.id
    } catch {
      userId = undefined
    }
    items = []
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i]
      const sourceName = s.kind === 'liked' ? LIKED_SONGS_NAME : s.playlist.name
      try {
        const { tracks } = await readTracks(
          source, s, `Reading "${sourceName}" (${i + 1}/${sources.length})`,
          !ctx.json && !ctx.quiet, deps.progressStream
        )
        const file = buildFile(source, ctx, s, tracks, userId)
        const playlistName = v.name ?? (s.kind === 'liked' ? likedPlaylistName(source) : s.playlist.name)
        items.push(newRunItem(file, { name: playlistName, sourceFilePath: `${source.id}:${s.kind === 'liked' ? 'liked' : s.playlist.ref}` }))
      } catch (error) {
        if (isFatal(error)) throw error
        skip(s.input, error)
      }
    }
    if (items.length === 0) {
      ctx.io.err('sple: nothing to migrate')
      return skipped.length > 0 ? partialFailureExitCode(skipCodes) : EXIT_CODES.SUCCESS
    }

    const trackCount = items.reduce((n, i) => n + i.file.tracks.length, 0)
    const noun = items.length === 1 ? 'playlist' : 'playlists'
    ctx.io.err(`${dryRun ? '[dry-run] ' : ''}Migrating ${items.length} ${noun} (${trackCount} ${trackCount === 1 ? 'track' : 'tracks'}) from ${v.from} to ${v.to}`)
    estimate = printEstimate(ctx, target, items, cache, dryRun)

    // ---- 4. Confirm once, before any request to the target ----
    if (!dryRun && !yes) {
      const prompt = deps.prompt ?? ((q: string) => confirm(q, false))
      if (!(await prompt(`Create ${items.length} private ${noun} on ${target.displayName}?`))) {
        ctx.io.err('Aborted; nothing was changed.')
        return EXIT_CODES.ERROR
      }
    }
    if (!dryRun) {
      store.prune()
      state = store.create('migrate', target.id, { minConfidence, cache: cache !== undefined }, items)
    }
  }

  // ---- 5. Each source in turn: match, then create and add (checkpointed) ----
  const reportDir = v.report !== undefined ? resolve(v.report) : undefined
  if (reportDir) mkdirSync(reportDir, { recursive: true })
  const writer = new MatchReportWriter()
  const results: MigratePlaylistResult[] = []
  const textMode = !ctx.json && !ctx.quiet

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const progress = createProgress(`Matching "${item.name}" (${i + 1}/${items.length})`, 'tracks', {
      enabled: textMode && item.phase === 'matching',
      stream: deps.progressStream,
    })
    let report: MatchReport
    try {
      if (state) {
        report = await matchRunItem(target, store, state, item, cache, (n, total) => progress.update(n, total))
      } else {
        let matched = 0
        report = await new MatchingEngine({ cache }).match(item.file, target, target.capabilities, {
          minConfidence,
          sourceFilePath: item.sourceFilePath,
          targetPlaylistName: item.name,
          onResult: () => progress.update(++matched, item.file.tracks.length),
        })
        item.report = report
      }
    } catch (error) {
      if (state) resumeHint(ctx, 'migrate', state)
      throw error
    } finally {
      progress.done()
    }
    log.info(`matched "${item.name}": ${report.summary.matched}/${report.summary.total}`)

    const result: MigratePlaylistResult = { source: sourceOf(item), name: item.name, summary: report.summary, added: 0, failed: [] }
    if (reportDir) {
      result.reportPath = join(reportDir, `${String(i + 1).padStart(2, '0')}-${slugify(item.name)}.json`)
      await writer.writeJson(report, result.reportPath)
    }

    if (!state) {
      if (textMode) {
        ctx.io.out(`[dry-run] "${result.source.name}" → "${item.name}": would add ${report.summary.matched} of ${report.summary.total} tracks (${counts(report.summary)})`)
      }
      results.push(result)
      continue
    }

    let written
    if (item.phase === 'done') {
      written = { playlist: item.playlist!, tracksAdded: item.added, failures: item.failed }
    } else {
      try {
        written = await writeRunItem(target, store, state, item)
      } catch (error) {
        throw stopped(ctx, 'migrate', state, error)
      }
    }
    result.playlist = written.playlist
    result.added = written.tracksAdded
    result.failed = written.failures
    results.push(result)

    if (textMode) {
      const url = written.playlist.url ? ` ${written.playlist.url}` : ''
      ctx.io.out(
        `"${result.source.name}" → "${written.playlist.name}" (${written.playlist.id})${url}: ` +
          `added ${written.tracksAdded} of ${report.summary.matched} matched tracks (${counts(report.summary)})`
      )
    } else if (ctx.quiet) {
      ctx.io.out(written.playlist.id)
    }
    for (const failure of written.failures) ctx.io.err(`sple: failed to add ${failure.ref}: ${failure.error}`)
  }
  if (state) store.delete(state.runId)

  // ---- 6. Result and summary ----
  const output: MigrateOutput = {
    dryRun, from, to: target.id, playlists: results, skipped, ...(estimate && { estimate }),
  }
  if (ctx.json) ctx.io.out(JSON.stringify(output))

  const trackFailures = results.reduce((n, r) => n + r.failed.length, 0)
  const codes = [...skipped.map((s) => s.error.exitCode), ...(trackFailures > 0 ? [EXIT_CODES.ERROR] : [])]
  if (codes.length === 0) {
    if (textMode) {
      const noun = results.length === 1 ? 'playlist' : 'playlists'
      ctx.io.err(dryRun ? `sple: [dry-run] matched ${results.length} ${noun}; nothing was created` : `sple: migrated ${results.length} ${noun}`)
    }
    return EXIT_CODES.SUCCESS
  }
  const attempted = results.length + skipped.length
  const parts = [
    ...(skipped.length > 0 ? [`${skipped.length} skipped`] : []),
    ...(trackFailures > 0 ? [`${trackFailures} track(s) failed to add`] : []),
  ]
  const summaryLine = `migrated ${results.length} of ${attempted} playlists; ${parts.join(', ')} (see above)`
  ctx.io.err(`sple: ${summaryLine}`)
  const exitCode = partialFailureExitCode(codes)
  if (ctx.json) ctx.io.err(formatErrorOutput(new Error(summaryLine), exitCode, 'PartialFailure'))
  return exitCode
}
