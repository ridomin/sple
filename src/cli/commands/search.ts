import { parseArgs } from 'node:util'
import type { CommandContext } from '../cli.js'
import { EXIT_CODES } from '../exit-codes.js'
import { emit, type ColumnDef } from '../output.js'
import { UsageError } from '../../core/provider/errors.js'
import type { SearchItem, SearchType } from '../../core/provider/provider.js'
import {
  searchAll,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_ALL_CAP,
  SEARCH_MAX_RESULTS_CEILING,
  type SearchOptions,
} from '../../core/search.js'

const USAGE =
  'Usage: sple search <query> [--type track|album|artist|playlist] [--limit N] [--offset N | --all [--max-results N]]'

const SEARCH_TYPES: readonly SearchType[] = ['track', 'album', 'artist', 'playlist']

export const name = 'search'
export const summary = 'Search the provider catalog'
export const usage = USAGE

function parseIntFlag(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`${flag} must be a non-negative integer (got '${value}')`)
  }
  return Number(value)
}

function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function toRows(type: SearchType, items: SearchItem[]): { rows: Array<Record<string, unknown>>; columns: ColumnDef[] } {
  switch (type) {
    case 'track':
      return {
        columns: [{ name: 'title' }, { name: 'artists' }, { name: 'album' }, { name: 'duration' }, { name: 'id' }],
        rows: items.map((i) =>
          i.type === 'track'
            ? {
                title: i.name,
                artists: i.track.artists.join(', '),
                album: i.track.album ?? '',
                duration: formatDuration(i.track.durationMs),
                id: i.id,
              }
            : { title: i.name, id: i.id }
        ),
      }
    case 'album':
      return {
        columns: [{ name: 'name' }, { name: 'artists' }, { name: 'released' }, { name: 'tracks' }, { name: 'id' }],
        rows: items.map((i) =>
          i.type === 'album'
            ? { name: i.name, artists: i.artists.join(', '), released: i.releaseDate, tracks: i.trackCount, id: i.id }
            : { name: i.name, id: i.id }
        ),
      }
    case 'artist':
      return {
        columns: [{ name: 'name' }, { name: 'id' }],
        rows: items.map((i) => ({ name: i.name, id: i.id })),
      }
    case 'playlist':
      return {
        columns: [{ name: 'name' }, { name: 'owner' }, { name: 'tracks' }, { name: 'id' }],
        rows: items.map((i) =>
          i.type === 'playlist'
            ? { name: i.name, owner: i.owner.displayName ?? i.owner.id, tracks: i.trackCount, id: i.id }
            : { name: i.name, id: i.id }
        ),
      }
  }
}

export async function run(ctx: CommandContext, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Search the ${ctx.config.provider} catalog.

Arguments:
  query  Search query (tracks, artists, albums)

Options:
  --type <type>       track, album, artist, or playlist (default: track)
  --limit N           Number of results (default: ${DEFAULT_SEARCH_LIMIT}); split across pages of the provider's search page size
  --offset N          Skip the first N results (offset-paginated providers only)
  --all               Read results until they run out or the cap is reached
  --max-results N     Cap for --all (default: ${DEFAULT_SEARCH_ALL_CAP}, max: ${SEARCH_MAX_RESULTS_CEILING})
  --provider <name>   Specify the provider (default: ${ctx.config.provider})
  --json              Output Page<SearchItem> as JSON
  --quiet             Print IDs only
  --help, -h          Show this help message

Examples:
  sple search "hello world"
  sple search "adele" --type album --limit 25
  sple search "lofi" --type playlist --all --max-results 200
`)
    return EXIT_CODES.SUCCESS
  }

  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        type: { type: 'string' },
        limit: { type: 'string' },
        offset: { type: 'string' },
        all: { type: 'boolean' },
        'max-results': { type: 'string' },
        // Output flags are also accepted after the command name.
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
      },
    })
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }

  const { values, positionals } = parsed
  const query = positionals.join(' ').trim()
  if (!query) {
    throw new UsageError(`${USAGE}\n\nNo search query provided`)
  }

  const type = (values.type ?? 'track') as SearchType
  if (!SEARCH_TYPES.includes(type)) {
    throw new UsageError(`--type must be one of: ${SEARCH_TYPES.join(', ')}`)
  }

  const opts: SearchOptions = {
    limit: parseIntFlag(values.limit, '--limit'),
    offset: parseIntFlag(values.offset, '--offset'),
    all: values.all === true,
    maxResults: parseIntFlag(values['max-results'], '--max-results'),
  }

  const provider = ctx.registry.create(ctx.config.provider, ctx.config)
  const page = await searchAll(provider, { text: query, type }, opts)

  const json = ctx.json || values.json === true
  const quiet = ctx.quiet || values.quiet === true
  if (json && quiet) {
    throw new UsageError('--json and --quiet cannot be used together')
  }

  if (json) {
    emit(ctx, { json: page })
  } else if (quiet) {
    emit(ctx, { quiet: page.items.map((i) => i.id) })
  } else {
    const { rows, columns } = toRows(type, page.items)
    emit(ctx, { table: rows, columns })
    if (page.items.length === 0) ctx.io.err(`No results for "${query}" in ${provider.displayName}`)
  }
  return EXIT_CODES.SUCCESS
}
