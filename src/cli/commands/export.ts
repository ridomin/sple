import type { CommandContext } from '../cli.js'
import { EXIT_CODES } from '../exit-codes.js'
import { UsageError } from '../../core/provider/errors.js'

const USAGE = 'Usage: sple export <playlist-id> [--format json|csv] [--provider <name>]'

export const name = 'export'
export const summary = 'Export playlists to files'
export const usage = USAGE

export async function run(ctx: CommandContext, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Export a playlist from ${ctx.config.provider} to a file.

Arguments:
  playlist-id  ID of the playlist to export

Options:
  --format <format>  Output format: json or csv (default: json)
  --provider <name>  Specify the provider (default: ${ctx.config.provider})
  --verbose          Enable verbose output
  --help, -h         Show this help message

Examples:
  sple export "37i9dQZF1DX3yvAYDslnv8"
  sple export "37i9dQZF1DX3yvAYDslnv8" --format csv
`)
    return EXIT_CODES.SUCCESS
  }

  const [playlistId] = args
  if (!playlistId) {
    throw new UsageError(`${USAGE}\n\nNo playlist ID provided`)
  }

  // Stub implementation
  ctx.io.out(`Exporting playlist ${playlistId} from ${ctx.config.provider}...`)
  ctx.io.out('(Export implementation coming in M1-16)')
  return EXIT_CODES.SUCCESS
}
