import type { CommandContext } from '../../cli.js'
import { EXIT_CODES } from '../../exit-codes.js'
import type { PlaylistCreateOutput } from '../../output/types.js'
import { UsageError } from '../../../core/provider/errors.js'
import { parseCommandArgs, selectOutputMode, tsvLine } from './shared.js'

const USAGE =
  'Usage: sple playlist create <name> [--description <text>] [--public | --private] [--collaborative] [--dry-run]'

export const name = 'create'
export const summary = 'Create a new playlist'
export const usage = USAGE

/** Environment probes, injectable for tests. */
export interface CreateDeps {
  stdoutIsTTY?: boolean
}

export async function run(ctx: CommandContext, args: string[], deps: CreateDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Create a new playlist in ${ctx.config.provider}.

Arguments:
  name  Name for the new playlist

Options:
  --description <text>  Playlist description
  --public              Make the playlist public
  --private             Make the playlist private (default)
  --collaborative       Let others edit the playlist (implies --private)
  --dry-run             Show what would be created without creating it
  --provider <name>     Specify the provider (default: ${ctx.config.provider})
  --json                Output the created playlist as JSON
  --quiet               Print the playlist ID only
  --help, -h            Show this help message

Examples:
  sple playlist create "My Favorites"
  sple playlist create "Road Trip" --description "Music for the drive" --public
  sple playlist create "Party" --collaborative --dry-run
`)
    return EXIT_CODES.SUCCESS
  }

  const { values, positionals } = parseCommandArgs(args, {
    description: { type: 'string' },
    public: { type: 'boolean' },
    private: { type: 'boolean' },
    collaborative: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  })

  if (positionals.length === 0 || positionals[0].trim() === '') {
    throw new UsageError(`${USAGE}\n\nNo playlist name provided`)
  }
  if (positionals.length > 1) {
    throw new UsageError(`${USAGE}\n\nExpected one playlist name; quote names that contain spaces`)
  }
  const playlistName = positionals[0]

  if (values.public && values.private) {
    throw new UsageError('--public and --private cannot be used together')
  }
  const collaborative = values.collaborative === true
  if (collaborative && values.public) {
    throw new UsageError('--collaborative playlists are always private; do not combine with --public')
  }
  const isPublic = values.public === true
  const description = values.description

  const mode = selectOutputMode(ctx, values, deps.stdoutIsTTY ?? process.stdout.isTTY === true)

  const provider = ctx.registry.create(ctx.config.provider, ctx.config)
  if (collaborative && !provider.capabilities.supportsCollaborative) {
    throw new UsageError(`${provider.displayName} does not support collaborative playlists`)
  }

  const visibility = collaborative ? 'collaborative' : isPublic ? 'public' : 'private'

  if (values['dry-run']) {
    const sentence = `[dry-run] Would create ${visibility} playlist "${playlistName}" in ${provider.displayName}`
    const output: PlaylistCreateOutput = {
      dryRun: true,
      name: playlistName,
      ...(description !== undefined ? { description } : {}),
      public: isPublic,
      collaborative,
    }
    switch (mode) {
      case 'json':
        ctx.io.out(JSON.stringify(output, null, 2))
        break
      case 'quiet':
        // Nothing was created, so there is no ID to print (ADR 0007 §2.6).
        break
      case 'table':
        ctx.io.out(sentence)
        break
      case 'tsv':
        // The row looks like a real run (ADR-0007 §2.6), so say it was a dry run on stderr.
        ctx.io.out(tsvLine(['', playlistName, '']))
        ctx.io.err(sentence)
        break
    }
    return EXIT_CODES.SUCCESS
  }

  const created = await provider.createPlaylist({
    name: playlistName,
    ...(description !== undefined ? { description } : {}),
    public: isPublic,
    ...(collaborative ? { collaborative: true } : {}),
  })

  const output: PlaylistCreateOutput = {
    dryRun: false,
    id: created.id,
    ref: created.ref,
    name: created.name,
    ...(created.description ? { description: created.description } : {}),
    ...(created.url ? { url: created.url } : {}),
    owner: created.owner,
    public: created.public ?? isPublic,
    collaborative: created.collaborative ?? collaborative,
  }

  switch (mode) {
    case 'json':
      ctx.io.out(JSON.stringify(output, null, 2))
      break
    case 'quiet':
      ctx.io.out(created.id)
      break
    case 'table':
      ctx.io.out(
        `Created ${visibility} playlist "${created.name}" (${created.id})${created.url ? ` ${created.url}` : ''}`
      )
      break
    case 'tsv':
      ctx.io.out(tsvLine([created.id, created.name, created.url]))
      break
  }
  return EXIT_CODES.SUCCESS
}
