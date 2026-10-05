import type { CommandContext } from '../../cli.js'
import { EXIT_CODES } from '../../exit-codes.js'
import { UsageError } from '../../../core/provider/errors.js'
import * as listCmd from './list.js'
import * as showCmd from './show.js'
import * as createCmd from './create.js'
import * as removeCmd from './remove.js'

const SUBCOMMANDS = ['list', 'show', 'create', 'remove'] as const

const USAGE = `Usage: sple playlist <command> [options]

Commands:
  list              List your playlists [--owned | --followed]
  show <playlist|-> Show the tracks of a playlist
  create <name>     Create a new playlist
  remove <id>       Delete a playlist

Options:
  --provider <name>  Specify the provider (default: spotify)
  --help, -h         Show help
`

export async function handlePlaylistCommand(
  ctx: CommandContext,
  args: string[]
): Promise<number> {
  const [subcommand, ...subArgs] = args

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    ctx.io.out(USAGE)
    return EXIT_CODES.SUCCESS
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new UsageError(
      `Unknown playlist subcommand: ${subcommand}. Run "sple playlist --help" for usage information`
    )
  }

  switch (subcommand) {
    case 'list':
      return await listCmd.run(ctx, subArgs)
    case 'show':
      return await showCmd.run(ctx, subArgs)
    case 'create':
      return await createCmd.run(ctx, subArgs)
    case 'remove':
      return await removeCmd.run(ctx, subArgs)
    default:
      throw new UsageError(`Unknown playlist subcommand: ${subcommand}`)
  }
}
