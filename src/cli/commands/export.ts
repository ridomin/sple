import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CommandContext } from '../cli.js'
import { EXIT_CODES, formatErrorMessage, formatErrorOutput, getExitCode } from '../exit-codes.js'
import { emit, type ColumnDef } from '../output.js'
import type { ErrorInfo, ExportOutput } from '../output/types.js'
import { readRefsFromStdin } from '../input.js'
import { createLogger } from '../log.js'
import { createProgress, type ProgressStream } from '../progress.js'
import { parseCommandArgs, selectOutputMode } from './playlist/shared.js'
import { notReadableMessage } from './playlist/show.js'
import {
  AccessRestrictedError,
  AuthRequiredError,
  QuotaExhaustedError,
  RateLimitError,
  UsageError,
} from '../../core/provider/errors.js'
import { collectPages } from '../../core/pagination.js'
import { resolvePlaylist } from '../../core/playlist-resolver.js'
import {
  createPlaylistFile,
  LIKED_SONGS_NAME,
  writeCSV,
  writeJSON,
  type CanonicalPlaylistFile,
} from '../../core/export/index.js'
import type { CanonicalTrack, PlaylistSummary, Provider } from '../../core/provider/provider.js'

const USAGE =
  'Usage: sple export <playlist…|-> [--liked] [-o <file|dir>] [--format json|csv] [--force]\n' +
  '       sple export --liked [-o <file|dir>] [--format json|csv] [--force]'

export const name = 'export'
export const summary = 'Export playlists to files'
export const usage = USAGE

export type ExportFormat = 'json' | 'csv'
const FORMATS: readonly ExportFormat[] = ['json', 'csv']

/** Liked Songs page size: Spotify's GET /me/tracks caps at 50 (S3). */
/** Exit-code priority among failed items (ADR 0007 §5): 3 > 5 > 4 > 1. */
const EXIT_PRIORITY: readonly number[] = [
  EXIT_CODES.AUTH_REQUIRED,
  EXIT_CODES.QUOTA_EXHAUSTED,
  EXIT_CODES.NOT_FOUND,
  EXIT_CODES.ERROR,
]

export interface ExportDeps {
  /** Reads playlist refs for `-` (default: stdin, rejecting a TTY). */
  readRefs?: () => Promise<string[]>
  /** Progress stream (default process.stderr). */
  progressStream?: ProgressStream
  /** Whether stdout is a terminal (default process.stdout.isTTY). */
  stdoutIsTTY?: boolean
}

/** One thing to export, after resolution. */
type Source =
  | { kind: 'playlist'; input: string; playlist: PlaylistSummary }
  | { kind: 'liked'; input: string }

type Skipped = ExportOutput['skipped'][number]
type Written = ExportOutput['files'][number]

/**
 * File-name slug: lower-case ASCII letters and digits joined by `-`,
 * at most 60 characters; `playlist` when nothing is left.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug || 'playlist'
}

/** `<slug(name)>-<id>.<ext>`, or `liked-songs.<ext>` (M1-26). */
export function exportFileName(source: Source, format: ExportFormat): string {
  if (source.kind === 'liked') return `liked-songs.${format}`
  return `${slugify(source.playlist.name)}-${source.playlist.id}.${format}`
}

/**
 * Write `content` to `path` atomically: a temp file in the same directory,
 * then rename over the target. Without `force`, an existing target is never
 * replaced. A failed write leaves no partial file behind.
 */
export function writeFileAtomic(path: string, content: string, force: boolean): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, content, { encoding: 'utf-8', flag: 'wx', mode: 0o644 })
    if (!force && existsSync(path)) {
      throw new UsageError(`${path} already exists; use --force to overwrite it`)
    }
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function serialize(file: CanonicalPlaylistFile, format: ExportFormat): string {
  return format === 'csv' ? writeCSV(file) : writeJSON(file)
}

/** Errors that would fail every remaining item the same way (ADR 0007 §5). */
function isFatal(error: unknown): boolean {
  return (
    error instanceof AuthRequiredError ||
    error instanceof RateLimitError ||
    error instanceof QuotaExhaustedError
  )
}

function errorInfo(error: unknown): ErrorInfo {
  return {
    type: error instanceof Error ? error.constructor.name : 'Error',
    message: formatErrorMessage(error),
    exitCode: getExitCode(error),
  }
}

/** Highest-priority exit code among failures (3 > 5 > 4 > 1). */
export function partialFailureExitCode(codes: number[]): number {
  for (const code of EXIT_PRIORITY) {
    if (codes.includes(code)) return code
  }
  return codes.length > 0 ? EXIT_CODES.ERROR : EXIT_CODES.SUCCESS
}

async function defaultReadRefs(): Promise<string[]> {
  if (process.stdin.isTTY) {
    throw new UsageError('"-" reads playlist refs from stdin, but stdin is a terminal')
  }
  return readRefsFromStdin()
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Read every track of one source, with progress. Throws for unreadable playlists. */
async function readTracks(
  provider: Provider,
  source: Source,
  label: string,
  progressEnabled: boolean,
  progressStream: ProgressStream | undefined
): Promise<{ tracks: CanonicalTrack[]; total?: number }> {
  if (source.kind === 'playlist' && !source.playlist.itemsReadable) {
    // Same message as `playlist show` (FR-PL-2), before any track request.
    throw new AccessRestrictedError(notReadableMessage(provider, source.playlist), 'not-owned')
  }
  const progress = createProgress(label, 'tracks', { enabled: progressEnabled, stream: progressStream })
  try {
    const fetchPage =
      source.kind === 'liked'
        ? (page: { limit: number; offset?: number; cursor?: string }) => provider.getLikedTracks(page)
        : (page: { limit: number; offset?: number; cursor?: string }) =>
            provider.getPlaylistTracks(source.playlist.ref, page)
    const pageSize =
      source.kind === 'liked' ? provider.capabilities.readPageSize.liked : provider.capabilities.readPageSize.playlistItems
    const { items, total } = await collectPages(fetchPage, {
      pageSize,
      model: provider.capabilities.paginationModel,
      onPage: (p) => progress.update(p.items, p.total),
    })
    return { tracks: items, total }
  } finally {
    progress.done()
  }
}

function buildFile(
  provider: Provider,
  ctx: CommandContext,
  source: Source,
  tracks: CanonicalTrack[],
  userId: string | undefined
): CanonicalPlaylistFile {
  // Providers return supported tracks only (ADR 0003 getPlaylistTracks), so
  // positions number the exported tracks and unsupportedItems stays empty.
  // See the M1 review item I1: carrying unsupported items needs an interface decision.
  const positioned = tracks.map((t, i) => ({ ...t, position: i + 1 }))
  const playlist =
    source.kind === 'liked'
      ? {}
      : {
          ref: source.playlist.ref,
          id: source.playlist.id,
          name: source.playlist.name,
          description: source.playlist.description,
          owner: source.playlist.owner,
          public: source.playlist.public,
          collaborative: source.playlist.collaborative,
          url: source.playlist.url,
        }
  return createPlaylistFile({
    generatorVersion: ctx.version,
    source: { provider: provider.id, kind: source.kind, userId },
    playlist,
    tracks: positioned,
  })
}

function sourceName(source: Source): string {
  return source.kind === 'liked' ? LIKED_SONGS_NAME : source.playlist.name
}

export async function run(ctx: CommandContext, args: string[], deps: ExportDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Export playlists (or your Liked Songs) from ${ctx.config.provider} to JSON or CSV files.

Arguments:
  playlist  Playlist ID, URI, URL, or exact name; "-" reads refs from stdin (one per line)

Options:
  --liked             Export your Liked Songs (saved tracks)
  -o, --output <path> File to write (one source) or directory (one or more sources).
                      Without -o, a single source is written to stdout.
  --format <format>   json (default, canonical format) or csv
  --force             Overwrite existing files
  --provider <name>   Specify the provider (default: ${ctx.config.provider})
  --json              With -o: print { files, skipped } as JSON
  --quiet             With -o: print written paths only
  --verbose           Enable verbose output
  --help, -h          Show this help message

Files in a directory are named <name>-<id>.<ext> (Liked Songs: liked-songs.<ext>).
If some playlists cannot be exported, the rest are still written and the exit
code reports the failure.

Examples:
  sple export "Road trip" > road-trip.json
  sple export 37i9dQZF1DX3yvAYDslnv8 --format csv -o road-trip.csv
  sple export --liked -o exports/
  sple playlist list --owned --quiet | sple export - -o exports/
`)
    return EXIT_CODES.SUCCESS
  }

  // ---- 1. Validate flags (nothing is read or written yet) ----
  const { values, positionals } = parseCommandArgs(args, {
    liked: { type: 'boolean' },
    output: { type: 'string', short: 'o' },
    format: { type: 'string' },
    force: { type: 'boolean' },
    all: { type: 'boolean' },
  })

  if (values.all) {
    throw new UsageError('"export --all" is available in a later release; pass playlists or use "playlist list --quiet | sple export - -o <dir>"')
  }
  const format = (values.format ?? 'json') as ExportFormat
  if (!FORMATS.includes(format)) {
    throw new UsageError(`--format must be json or csv (got '${values.format}')`)
  }
  if (values.output !== undefined && values.output.trim() === '') {
    throw new UsageError('-o needs a file or directory path')
  }
  const dashCount = positionals.filter((p) => p === '-').length
  if (dashCount > 1) throw new UsageError('"-" may appear only once')
  if (dashCount === 1 && positionals.length > 1) {
    throw new UsageError('"-" cannot be combined with other playlist arguments')
  }
  if (positionals.some((p) => p.trim() === '')) throw new UsageError('Empty playlist argument')
  if (positionals.length === 0 && !values.liked) {
    throw new UsageError(`${USAGE}\n\nNo playlist provided`)
  }

  const force = values.force === true
  const json = ctx.json || values.json === true
  const quiet = ctx.quiet || values.quiet === true
  if (json && quiet) throw new UsageError('--json and --quiet cannot be used together')

  // ---- 2. Read stdin ----
  let inputs = positionals
  if (dashCount === 1) {
    inputs = await (deps.readRefs ?? defaultReadRefs)()
    if (inputs.length === 0) throw new UsageError('No playlist refs on stdin')
  }
  const sourceCount = inputs.length + (values.liked ? 1 : 0)

  // ---- 3. Decide the destination ----
  const output = values.output
  const toStdout = output === undefined
  if (toStdout && sourceCount > 1) {
    throw new UsageError('Exporting several sources needs -o <directory>')
  }
  if (toStdout && json) {
    // ADR 0007 §3.6: stdout is the export file itself; use --format json for the data.
    throw new UsageError('--json does not apply when exporting to stdout; use --format json, or -o <path>')
  }
  const outputPath = output === undefined ? undefined : resolve(output)
  const dirMode =
    outputPath !== undefined &&
    (sourceCount > 1 || output!.endsWith('/') || output!.endsWith(sep) || isDirectory(outputPath))
  if (dirMode && existsSync(outputPath!) && !isDirectory(outputPath!)) {
    throw new UsageError(`${output} is not a directory`)
  }
  if (!dirMode && outputPath !== undefined && isDirectory(dirname(outputPath)) === false) {
    throw new UsageError(`Directory ${dirname(outputPath)} does not exist`)
  }

  const mode = toStdout ? undefined : selectOutputMode(ctx, values, deps.stdoutIsTTY ?? process.stdout.isTTY ?? false)
  const log = createLogger('export', ctx)
  const provider = ctx.registry.create(ctx.config.provider, ctx.config)

  // ---- 4. Resolve every input before writing anything (ADR 0007 §5) ----
  const sources: Source[] = []
  const skipped: Skipped[] = []
  const failCodes: number[] = []
  const reportSkip = (input: string, error: unknown) => {
    const info = errorInfo(error)
    skipped.push({ input, error: info })
    failCodes.push(info.exitCode)
    ctx.io.err(`sple: skipped "${input}": ${info.message}`)
  }

  const seen = new Set<string>()
  for (const input of inputs) {
    try {
      const playlist = await resolvePlaylist(provider, input)
      if (seen.has(playlist.id)) {
        ctx.io.err(`sple: warning: "${input}" is the same playlist as an earlier argument; exported once`)
        continue
      }
      seen.add(playlist.id)
      log.info(`resolved "${input}" to ${playlist.id}`)
      sources.push({ kind: 'playlist', input, playlist })
    } catch (error) {
      // Usage problems (ambiguous names) and errors that would fail every item stop here, with nothing written.
      if (error instanceof UsageError || isFatal(error) || toStdout) throw error
      reportSkip(input, error)
    }
  }
  if (values.liked) sources.push({ kind: 'liked', input: '--liked' })

  // Target paths, checked up front so an existing file is a usage error before any write.
  const targets = new Map<Source, string>()
  if (outputPath !== undefined) {
    for (const source of sources) {
      const path = dirMode ? join(outputPath, exportFileName(source, format)) : outputPath
      if (!force && existsSync(path)) {
        throw new UsageError(`${path} already exists; use --force to overwrite it`)
      }
      targets.set(source, path)
    }
    if (dirMode) mkdirSync(outputPath, { recursive: true })
  }

  let userId: string | undefined
  try {
    userId = (await provider.auth.status()).user?.id
  } catch {
    userId = undefined
  }

  // ---- 5. Export each source; per-item failures do not stop the rest ----
  const progressEnabled = !json && !quiet
  const written: Written[] = []
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    const label =
      sources.length > 1
        ? `Exporting "${sourceName(source)}" (${i + 1}/${sources.length} playlists)`
        : `Exporting "${sourceName(source)}"`
    try {
      const { tracks, total } = await readTracks(provider, source, label, progressEnabled, deps.progressStream)
      const unsupported = total !== undefined ? Math.max(0, total - tracks.length) : 0
      if (unsupported > 0) {
        ctx.io.err(
          `sple: warning: ${unsupported} of ${total} items in "${sourceName(source)}" are not supported ` +
            '(local files, podcast episodes, or unavailable tracks) and were not exported'
        )
      }
      const file = buildFile(provider, ctx, source, tracks, userId)
      const content = serialize(file, format)

      const path = targets.get(source)
      if (path === undefined) {
        // stdout carries the file itself; io.out adds the final newline back.
        ctx.io.out(content.endsWith('\n') ? content.slice(0, -1) : content)
        return EXIT_CODES.SUCCESS
      }
      writeFileAtomic(path, content, force)
      log.info(`wrote ${tracks.length} tracks to ${path}`)
      written.push({
        path,
        format,
        source:
          source.kind === 'liked'
            ? { kind: 'liked', name: LIKED_SONGS_NAME }
            : { kind: 'playlist', id: source.playlist.id, name: source.playlist.name },
        trackCount: tracks.length,
        unsupportedCount: unsupported,
      })
    } catch (error) {
      if (toStdout) throw error
      reportSkip(source.input, error)
      if (isFatal(error)) {
        // The remaining items would fail the same way: report them as skipped too.
        for (const rest of sources.slice(i + 1)) {
          const info = errorInfo(error)
          skipped.push({ input: rest.input, error: info })
          failCodes.push(info.exitCode)
        }
        break
      }
    }
  }

  // ---- 6. Result and summary ----
  const result: ExportOutput = { files: written, skipped }
  if (mode === 'json') {
    emit(ctx, { json: result })
  } else if (mode === 'quiet') {
    emit(ctx, { quiet: written.map((w) => w.path) })
  } else {
    const columns: ColumnDef[] = [{ name: 'path' }, { name: 'format' }, { name: 'tracks' }]
    emit(ctx, { table: written.map((w) => ({ path: w.path, format: w.format, tracks: w.trackCount })), columns })
  }

  const attempted = written.length + skipped.length
  const noun = attempted === 1 ? 'playlist' : 'playlists'
  if (skipped.length === 0) {
    if (!quiet && !json) ctx.io.err(`sple: exported ${written.length} ${noun}`)
    return EXIT_CODES.SUCCESS
  }

  const summaryLine = `exported ${written.length} of ${attempted} ${noun}; ${skipped.length} skipped (see above)`
  ctx.io.err(`sple: ${summaryLine}`)
  const exitCode = partialFailureExitCode(failCodes)
  if (json) ctx.io.err(formatErrorOutput(new Error(summaryLine), exitCode, 'PartialFailure'))
  return exitCode
}
