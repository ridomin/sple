import type { CommandContext } from '../../cli.js'
import { EXIT_CODES } from '../../exit-codes.js'
import { UsageError } from '../../../core/provider/errors.js'

const USAGE = 'Usage: sple playlist show <playlist-id> [--provider <name>]'

export const name = 'show'
export const summary = 'Show playlist details'
export const usage = USAGE

export async function run(ctx: CommandContext, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Show details and tracks for a playlist.

Arguments:
  playlist-id  ID of the playlist to show

Options:
  --provider <name>  Specify the provider (default: ${ctx.config.provider})
  --json             Output in JSON format
  --verbose          Enable verbose output
  --help, -h         Show this help message

Examples:
  sple playlist show "37i9dQZF1DX3yvAYDslnv8"
  sple --provider youtube-music playlist show "PLAYLIST_ID"
`)
    return EXIT_CODES.SUCCESS
  }

  const [playlistId] = args
  if (!playlistId) {
    throw new UsageError(`${USAGE}\n\nNo playlist ID provided`)
  }

  // Stub implementation
  ctx.io.out(`Showing playlist ${playlistId} from ${ctx.config.provider}...`)
  ctx.io.out('(Playlist details implementation coming in M1-15)')
  return EXIT_CODES.SUCCESS
}
