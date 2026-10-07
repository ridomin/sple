import type { CommandContext } from '../../cli.js'
import { EXIT_CODES } from '../../exit-codes.js'
import { emit, type ColumnDef } from '../../output.js'
import type { PlaylistShowOutput } from '../../output/types.js'
import { readRefsFromStdin } from '../../input.js'
import { createProgress, type ProgressStream } from '../../progress.js'
import { parseCommandArgs, selectOutputMode } from './shared.js'
import { AccessRestrictedError, UsageError } from '../../../core/provider/errors.js'
import { collectPages } from '../../../core/pagination.js'
import { resolvePlaylist } from '../../../core/playlist-resolver.js'
import type { CanonicalTrack, PlaylistSummary, Provider } from '../../../core/provider/provider.js'

const USAGE = 'Usage: sple playlist show <playlist|-> [--json | --quiet]'

export const name = 'show'
export const summary = 'Show the tracks of a playlist'
export const usage = USAGE

export interface ShowDeps {
  /** Reads playlist refs for `-` (default: stdin, rejecting a TTY). */
  readRefs?: () => Promise<string[]>
  /** Progress stream (default process.stderr). */
  progressStream?: ProgressStream
}

async function defaultReadRefs(): Promise<string[]> {
  if (process.stdin.isTTY) {
    throw new UsageError('"-" reads a playlist ref from stdin, but stdin is a terminal')
  }
  return readRefsFromStdin()
}

/**
 * FR-PL-2 message for a playlist whose tracks the provider will not return.
 * Worded from capabilities only, so it stays provider-agnostic.
 */
export function notReadableMessage(provider: Provider, playlist: PlaylistSummary): string {
  const owner = playlist.owner.displayName || playlist.owner.id
  const rule =
    provider.capabilities.playlistItemsAccess === 'owned-or-collaborator'
      ? 'playlists you own or collaborate on'
      : 'playlists you own'
  return (
    `cannot read the tracks of "${playlist.name}" (owned by ${owner}). ` +
    `${provider.displayName} only returns the tracks of ${rule}. ` +
    `Workaround: in the ${provider.displayName} app, copy its tracks into a playlist you own, then use that playlist.`
  )
}

/** `m:ss`, or `h:mm:ss` from one hour (ADR-0007 §2.1). */
export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Table: local `YYYY-MM-DD`; TSV: ISO 8601 UTC (ADR-0007 §2.1/§2.2). */
function formatAddedAt(tty: boolean): (v: unknown) => string {
  return (v) => {
    if (typeof v !== 'string' || v === '') return ''
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) return v
    if (!tty) return d.toISOString()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
}

async function readSingleRef(deps: ShowDeps): Promise<string> {
  const refs = await (deps.readRefs ?? defaultReadRefs)()
  if (refs.length !== 1) {
    throw new UsageError(
      `"playlist show -" needs exactly one playlist ref on stdin (got ${refs.length})`
    )
  }
  return refs[0]
}

export async function run(ctx: CommandContext, args: string[], deps: ShowDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Show the tracks of a playlist.

Arguments:
  playlist  Playlist ID, URI, URL, or exact name; "-" reads one ref from stdin

Options:
  --provider <name>  Specify the provider (default: ${ctx.config.provider})
  --json             Output { playlist, tracks, unsupportedItems } as JSON
  --quiet            Print track refs only (one per line)
  --verbose          Enable verbose output
  --help, -h         Show this help message

Columns: #, title, artists, album, duration, added at, id

Exit codes: 1 if the provider does not let you read this playlist's tracks,
2 if the name matches several playlists, 4 if no playlist matches.

Examples:
  sple playlist show "Road trip"
  sple playlist show 37i9dQZF1DX3yvAYDslnv8 --json
  sple playlist list --owned --quiet | head -1 | sple playlist show -
`)
    return EXIT_CODES.SUCCESS
  }

  const { values, positionals } = parseCommandArgs(args, {})

  if (positionals.length === 0) {
    throw new UsageError(`${USAGE}\n\nNo playlist provided`)
  }
  if (positionals.length > 1) {
    throw new UsageError(`${USAGE}\n\nExpected one playlist, got ${positionals.length} (quote names with spaces)`)
  }
  const mode = selectOutputMode(ctx, values, process.stdout.isTTY ?? false)
  const json = mode === 'json'
  const quiet = mode === 'quiet'

  const input = positionals[0] === '-' ? await readSingleRef(deps) : positionals[0]

  const provider = ctx.registry.create(ctx.config.provider, ctx.config)
  const playlist = await resolvePlaylist(provider, input)

  // FR-PL-2: fail before any output or track request when tracks are not readable.
  if (!playlist.itemsReadable) {
    throw new AccessRestrictedError(notReadableMessage(provider, playlist), 'not-owned')
  }
  if (!playlist.owned && provider.capabilities.playlistItemsAccess !== 'all') {
    const owner = playlist.owner.displayName || playlist.owner.id
    ctx.io.err(`sple: note: "${playlist.name}" is owned by ${owner}; readable via collaborator access`)
  }

  const progress = createProgress(`Reading "${playlist.name}"`, 'tracks', {
    enabled: !json && !quiet,
    stream: deps.progressStream,
  })
  let tracks: CanonicalTrack[]
  let total: number | undefined
  try {
    ;({ items: tracks, total } = await collectPages(
      (page) => provider.getPlaylistTracks(playlist.ref, page),
      {
        pageSize: provider.capabilities.readPageSize.playlistItems,
        model: provider.capabilities.paginationModel,
        onPage: (p) => progress.update(p.items, p.total),
      }
    ))
  } finally {
    progress.done()
  }

  // Providers return supported tracks only. When they report the playlist's
  // item count, the difference is the number of unsupported items.
  const unsupported = total !== undefined ? Math.max(0, total - tracks.length) : 0
  if (unsupported > 0) {
    ctx.io.err(
      `sple: warning: ${unsupported} of ${total} items in "${playlist.name}" are not supported ` +
        '(local files, podcast episodes, or unavailable tracks) and are not shown'
    )
  }

  const withPosition = tracks.map((t, i) => ({ ...t, position: i + 1 }))

  if (json) {
    const output = {
      playlist,
      tracks: withPosition,
      unsupportedItems: [],
    } satisfies PlaylistShowOutput
    emit(ctx, { json: output })
  } else if (quiet) {
    emit(ctx, {
      quiet: tracks.map((t) => t.refs[provider.id]).filter((r): r is string => typeof r === 'string'),
    })
  } else {
    const columns: ColumnDef[] = [
      { name: '#' },
      { name: 'title' },
      { name: 'artists' },
      { name: 'album' },
      { name: 'duration' },
      { name: 'added at', formatter: formatAddedAt(mode === 'table') },
      { name: 'id' },
    ]
    const rows = withPosition.map((t) => ({
      '#': t.position,
      title: t.title,
      artists: t.artists.join(', '),
      album: t.album,
      duration: formatDuration(t.durationMs),
      'added at': t.addedAt,
      id: t.refs[provider.id],
    }))
    emit(ctx, { table: rows, columns })
    if (tracks.length === 0) ctx.io.err(`Playlist "${playlist.name}" has no tracks.`)
  }
  return EXIT_CODES.SUCCESS
}
