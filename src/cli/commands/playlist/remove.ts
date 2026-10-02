import type { CommandContext } from '../../cli.js'
import { EXIT_CODES } from '../../exit-codes.js'
import { UsageError } from '../../../core/provider/errors.js'

const USAGE = 'Usage: sple playlist remove <playlist-id> [--provider <name>]'

export const name = 'remove'
export const summary = 'Delete a playlist'
export const usage = USAGE

export async function run(ctx: CommandContext, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Delete a playlist from ${ctx.config.provider}.

Arguments:
  playlist-id  ID of the playlist to delete

Options:
  --provider <name>  Specify the provider (default: ${ctx.config.provider})
  --verbose          Enable verbose output
  --help, -h         Show this help message

Examples:
  sple playlist remove "37i9dQZF1DX3yvAYDslnv8"
  sple --provider youtube-music playlist remove "PLAYLIST_ID"
`)
    return EXIT_CODES.SUCCESS
  }

  const [playlistId] = args
  if (!playlistId) {
    throw new UsageError(`${USAGE}\n\nNo playlist ID provided`)
  }

  // Stub implementation
  ctx.io.out(`Deleting playlist ${playlistId} from ${ctx.config.provider}...`)
  ctx.io.out('(Playlist deletion implementation coming in M1-17)')
  return EXIT_CODES.SUCCESS
}
