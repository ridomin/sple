import type { CommandContext } from '../../cli.js'
import { EXIT_CODES } from '../../exit-codes.js'
import { UsageError } from '../../../core/provider/errors.js'

const USAGE = 'Usage: sple playlist create <name> [--description <desc>] [--provider <name>]'

export const name = 'create'
export const summary = 'Create a new playlist'
export const usage = USAGE

export async function run(ctx: CommandContext, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Create a new playlist in ${ctx.config.provider}.

Arguments:
  name  Name for the new playlist

Options:
  --description <desc>  Playlist description
  --provider <name>     Specify the provider (default: ${ctx.config.provider})
  --verbose             Enable verbose output
  --help, -h            Show this help message

Examples:
  sple playlist create "My Favorites"
  sple playlist create "Road Trip" --description "Music for the drive"
`)
    return EXIT_CODES.SUCCESS
  }

  const [name] = args
  if (!name) {
    throw new UsageError(`${USAGE}\n\nNo playlist name provided`)
  }

  // Stub implementation
  ctx.io.out(`Creating playlist "${name}" in ${ctx.config.provider}...`)
  ctx.io.out('(Playlist creation implementation coming in M1-17)')
  return EXIT_CODES.SUCCESS
}
