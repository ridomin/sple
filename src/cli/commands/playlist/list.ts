import type { CommandContext } from '../../cli.js'
import { EXIT_CODES } from '../../exit-codes.js'
import { emit, type ColumnDef } from '../../output.js'
import type { PlaylistListOutput } from '../../output/types.js'
import { createProgress, type ProgressStream } from '../../progress.js'
import { parseCommandArgs, selectOutputMode } from './shared.js'
import { UsageError } from '../../../core/provider/errors.js'
import { collectPages } from '../../../core/pagination.js'
import type { PlaylistFilter, PlaylistSummary, Provider } from '../../../core/provider/provider.js'

const USAGE = 'Usage: sple playlist list [--owned | --followed] [--json | --quiet]'

/** Page size for listing playlists (Spotify caps GET /me/playlists at 50). */
export const PLAYLIST_LIST_PAGE_SIZE = 50

export const name = 'list'
export const summary = 'List playlists'
export const usage = USAGE

export interface ListDeps {
  /** Progress stream (default process.stderr). */
  progressStream?: ProgressStream
}

/**
 * Read every playlist in the user's library, with bounded page concurrency.
 *
 * The owned/followed filter is applied here on `PlaylistSummary.owned`, with
 * the same meaning as the provider-side `PlaylistFilter` (ADR-0003). Reading
 * unfiltered keeps the provider's `total`, which is what lets later pages be
 * fetched concurrently.
 */
export async function listAllPlaylists(
  provider: Provider,
  filter: PlaylistFilter | undefined,
  onPage?: (pages: number, totalPages?: number) => void
): Promise<PlaylistSummary[]> {
  const { items } = await collectPages((page) => provider.listPlaylists(page), {
    pageSize: PLAYLIST_LIST_PAGE_SIZE,
    model: provider.capabilities.paginationModel,
    onPage: (p) => onPage?.(p.pages, p.totalPages),
  })
  if (filter === 'owned') return items.filter((p) => p.owned)
  if (filter === 'followed') return items.filter((p) => !p.owned)
  return items
}

function boolFormatter(tty: boolean): (v: unknown) => string {
  return (v) => (typeof v === 'boolean' ? (tty ? (v ? 'yes' : 'no') : String(v)) : '')
}

export async function run(ctx: CommandContext, args: string[], deps: ListDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

List the playlists in your ${ctx.config.provider} library.

Options:
  --owned            Only playlists you own
  --followed         Only playlists you follow but do not own
  --provider <name>  Specify the provider (default: ${ctx.config.provider})
  --json             Output { playlists, total } as JSON
  --quiet            Print playlist IDs only (one per line)
  --verbose          Enable verbose output
  --help, -h         Show this help message

Columns: name, id, tracks, owner, owned, public, collaborative

Examples:
  sple playlist list
  sple playlist list --owned
  sple playlist list --owned --quiet | sple export - -o out/
`)
    return EXIT_CODES.SUCCESS
  }

  const { values, positionals } = parseCommandArgs(args, {
    owned: { type: 'boolean' },
    followed: { type: 'boolean' },
  })

  if (positionals.length > 0) {
    throw new UsageError(`${USAGE}\n\nUnexpected argument: ${positionals[0]}`)
  }
  if (values.owned && values.followed) {
    throw new UsageError('--owned and --followed cannot be used together')
  }
  const mode = selectOutputMode(ctx, values, process.stdout.isTTY ?? false)
  const json = mode === 'json'
  const quiet = mode === 'quiet'
  const filter: PlaylistFilter | undefined = values.owned ? 'owned' : values.followed ? 'followed' : undefined

  const provider = ctx.registry.create(ctx.config.provider, ctx.config)
  const progress = createProgress('Fetching playlists', 'pages', {
    enabled: !json && !quiet,
    stream: deps.progressStream,
  })

  let playlists: PlaylistSummary[]
  try {
    playlists = await listAllPlaylists(provider, filter, (pages, totalPages) =>
      progress.update(pages, totalPages)
    )
  } finally {
    progress.done()
  }

  if (json) {
    const output = { playlists, total: playlists.length } satisfies PlaylistListOutput
    emit(ctx, { json: output })
  } else if (quiet) {
    emit(ctx, { quiet: playlists.map((p) => p.id) })
  } else {
    const bool = boolFormatter(mode === 'table')
    const columns: ColumnDef[] = [
      { name: 'name' },
      { name: 'id' },
      { name: 'tracks' },
      { name: 'owner' },
      { name: 'owned', formatter: bool },
      { name: 'public', formatter: bool },
      { name: 'collaborative', formatter: bool },
    ]
    const rows = playlists.map((p) => ({
      name: p.name,
      id: p.id,
      tracks: p.trackCount,
      owner: p.owner.displayName || p.owner.id,
      owned: p.owned,
      public: p.public,
      collaborative: p.collaborative,
    }))
    emit(ctx, { table: rows, columns })
  }

  if (playlists.length === 0 && !json && !quiet) ctx.io.err('No playlists.')
  return EXIT_CODES.SUCCESS
}
