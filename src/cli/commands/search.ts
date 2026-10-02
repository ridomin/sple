import type { CommandContext } from '../cli.js'
import { EXIT_CODES } from '../exit-codes.js'
import { UsageError } from '../../core/provider/errors.js'

const USAGE = 'Usage: sple search <query> [--provider <name>]'

export const name = 'search'
export const summary = 'Search the provider catalog'
export const usage = USAGE

export async function run(ctx: CommandContext, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Search for tracks in the ${ctx.config.provider} catalog.

Arguments:
  query  Search query (tracks, artists, albums)

Options:
  --provider <name>  Specify the provider (default: ${ctx.config.provider})
  --json             Output in JSON format
  --verbose          Enable verbose output
  --help, -h         Show this help message

Examples:
  sple search "hello world"
  sple --provider youtube-music search "adele easy on me"
`)
    return EXIT_CODES.SUCCESS
  }

  const [query] = args
  if (!query) {
    throw new UsageError(`${USAGE}\n\nNo search query provided`)
  }

  // Stub implementation
  ctx.io.out(`Searching for "${query}" in ${ctx.config.provider}...`)
  ctx.io.out('(Search implementation coming in M1-15)')
  return EXIT_CODES.SUCCESS
}
