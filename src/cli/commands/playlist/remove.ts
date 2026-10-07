import type { CommandContext } from '../../cli.js'
import { EXIT_CODES } from '../../exit-codes.js'
import { confirm, readRefsFromStdin } from '../../input.js'
import type { PlaylistRemoveOutput } from '../../output/types.js'
import { UsageError } from '../../../core/provider/errors.js'
import type { Provider } from '../../../core/provider/provider.js'
import { resolvePlaylist } from '../../../core/playlist-resolver.js'
import { parseCommandArgs, selectOutputMode, tsvLine } from './shared.js'

const USAGE = 'Usage: sple playlist remove <playlist|-> [--yes] [--dry-run]'

export const name = 'remove'
export const summary = 'Delete a playlist'
export const usage = USAGE

/** Environment probes and prompts, injectable for tests. */
export interface RemoveDeps {
  stdoutIsTTY?: boolean
  stdinIsTTY?: boolean
  readRefs?: () => Promise<string[]>
  /** Ask a yes/no question on stderr; resolves true on yes. */
  prompt?: (question: string) => Promise<boolean>
}

type RemoveAction = PlaylistRemoveOutput['action']

/** The action follows the provider's capability, never its id (ADR 0003, ADR 0007 §3.5). */
export function removeAction(provider: Pick<Provider, 'capabilities'>): RemoveAction {
  return provider.capabilities.canDeletePlaylist ? 'deleted' : 'unfollowed'
}

/** User-facing explanation of what `remove` does on this provider. */
export function removeNotice(provider: Pick<Provider, 'capabilities' | 'displayName'>): string {
  const name = provider.displayName
  if (provider.capabilities.canDeletePlaylist) {
    return `This permanently deletes the playlist from ${name}.`
  }
  return (
    `${name} cannot delete playlists; this unfollows it (removes it from your library). ` +
    `Owned playlists can be restored from your ${name} account page.`
  )
}

const VERB: Record<RemoveAction, { present: string; past: string }> = {
  deleted: { present: 'delete', past: 'Deleted' },
  unfollowed: { present: 'unfollow', past: 'Unfollowed' },
}

export async function run(ctx: CommandContext, args: string[], deps: RemoveDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.io.out(`${USAGE}

Remove a playlist from your ${ctx.config.provider} library. Providers that
cannot delete playlists (such as Spotify) unfollow it instead.

Arguments:
  playlist  Playlist ID, URI, URL, or exact name; "-" reads one ref from stdin

Options:
  --yes              Do not ask for confirmation (required when stdin is not a terminal)
  --dry-run          Resolve the playlist and show the planned action without changing anything
  --provider <name>  Specify the provider (default: ${ctx.config.provider})
  --json             Output the result as JSON
  --quiet            Print the playlist ID only
  --help, -h         Show this help message

Examples:
  sple playlist remove "37i9dQZF1DX3yvAYDslnv8"
  sple playlist remove "Road Trip" --dry-run
  echo 37i9dQZF1DX3yvAYDslnv8 | sple playlist remove - --yes
`)
    return EXIT_CODES.SUCCESS
  }

  const { values, positionals } = parseCommandArgs(args, {
    yes: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  })

  if (positionals.length === 0 || positionals[0].trim() === '') {
    throw new UsageError(`${USAGE}\n\nNo playlist provided`)
  }
  if (positionals.length > 1) {
    throw new UsageError(`${USAGE}\n\nExpected exactly one playlist; quote names that contain spaces`)
  }

  const input = positionals[0]
  const yes = ctx.yes || values.yes === true
  const dryRun = values['dry-run'] === true
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true
  const mode = selectOutputMode(ctx, values, deps.stdoutIsTTY ?? process.stdout.isTTY === true)

  // Validate confirmation requirements before any request (ADR 0007 §7).
  // A dry run changes nothing, so it never needs confirmation.
  if (!yes && !dryRun) {
    if (input === '-') {
      throw new UsageError('"playlist remove -" reads stdin, so it cannot ask for confirmation. Use --yes.')
    }
    if (!stdinIsTTY) {
      throw new UsageError('Confirmation required but stdin is not a terminal. Use --yes to skip confirmation.')
    }
  }

  let ref = input
  if (input === '-') {
    if (stdinIsTTY) {
      throw new UsageError('"-" reads a playlist ref from stdin, but stdin is a terminal')
    }
    const refs = await (deps.readRefs ?? readRefsFromStdin)()
    if (refs.length !== 1) {
      throw new UsageError(`"playlist remove -" needs exactly one playlist ref on stdin (got ${refs.length})`)
    }
    ref = refs[0]
  }

  const provider = ctx.registry.create(ctx.config.provider, ctx.config)
  const playlist = await resolvePlaylist(provider, ref)
  const action = removeAction(provider)
  const verb = VERB[action]
  const notice = removeNotice(provider)
  const showProse = mode === 'table' || mode === 'tsv'

  if (!dryRun && !yes) {
    ctx.io.err(notice)
    const prompt = deps.prompt ?? ((q: string) => confirm(q, false))
    const ok = await prompt(
      `${verb.present[0].toUpperCase()}${verb.present.slice(1)} playlist "${playlist.name}" (${playlist.id})?`
    )
    if (!ok) {
      ctx.io.err('Aborted; nothing was changed.')
      return EXIT_CODES.ERROR
    }
  }

  if (!dryRun) {
    await provider.removePlaylist(playlist.ref)
  } else if (showProse) {
    ctx.io.err(notice)
  }

  const output: PlaylistRemoveOutput = {
    dryRun,
    action,
    playlist: { id: playlist.id, ref: playlist.ref, name: playlist.name },
  }

  const dryRunSentence = `[dry-run] Would ${verb.present} playlist "${playlist.name}" (${playlist.id}) in ${provider.displayName}`
  switch (mode) {
    case 'json':
      ctx.io.out(JSON.stringify(output, null, 2))
      break
    case 'quiet':
      ctx.io.out(playlist.id)
      break
    case 'table':
      ctx.io.out(dryRun ? dryRunSentence : `${verb.past} playlist "${playlist.name}" (${playlist.id})`)
      break
    case 'tsv':
      ctx.io.out(tsvLine([action, playlist.id, playlist.name]))
      // The row looks like a real run (ADR-0007 §2.6), so say it was a dry run on stderr.
      if (dryRun) ctx.io.err(dryRunSentence)
      break
  }
  return EXIT_CODES.SUCCESS
}
