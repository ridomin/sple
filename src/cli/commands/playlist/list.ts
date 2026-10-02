import type { CommandContext } from '../../cli.js'
import { EXIT_CODES } from '../../exit-codes.js'

const USAGE = 'Usage: sple playlist list [--provider <name>]'

export const name = 'list'
export const summary = 'List playlists'
export const usage = USAGE

export async function run(ctx: CommandContext, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

List all playlists for the authenticated user.

Options:
  --provider <name>  Specify the provider (default: ${ctx.config.provider})
  --json             Output in JSON format
  --verbose          Enable verbose output
  --help, -h         Show this help message

Examples:
  sple playlist list
  sple --provider youtube-music playlist list
`)
    return EXIT_CODES.SUCCESS
  }

  // Stub implementation
  ctx.io.out(`Listing playlists from ${ctx.config.provider}...`)
  ctx.io.out('(Playlist listing implementation coming in M1-15)')
  return EXIT_CODES.SUCCESS
}
