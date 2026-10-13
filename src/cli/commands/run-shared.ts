import type { CommandContext } from '../cli.js'
import { UsageError } from '../../core/provider/errors.js'
import type { Provider } from '../../core/provider/provider.js'
import type { MatchCache } from '../../core/matching/match-cache.js'
import { PlaylistAddTracksError } from '../../core/import/playlist-errors.js'
import type { RunItem, RunState, RunStore } from '../../core/import/run-store.js'
import { QuotaLedger } from '../../core/quota/ledger.js'
import { countImportWork, estimateQuota, type QuotaEstimate } from '../../core/quota/estimate.js'

/** Shared by `import` and `migrate`: resumable runs (ADR 0007 Amendments 4 and 6) and the quota estimate (ADR 0002 Amendment 5). */

/** One line describing how far a run item has got. */
export function describeProgress(item: RunItem): string {
  switch (item.phase) {
    case 'matching':
      return `matched ${item.results.length} of ${item.file.tracks.length} tracks`
    case 'matched':
      return 'matched, playlist not created yet'
    default:
      return `added ${item.cursor} of ${item.toAdd.length} tracks`
  }
}

/** One line describing how far a whole run has got. */
function describeRun(state: RunState): string {
  if (state.kind === 'import') return `"${state.items[0].name}" → ${state.target} (${describeProgress(state.items[0])})`
  const done = state.items.filter((i) => i.phase === 'done').length
  return `${state.items.length} playlists → ${state.target} (${done} done)`
}

/**
 * The unfinished run `id` of `kind` (`last`: the newest), after deleting
 * expired runs. Throws a UsageError listing the resumable runs otherwise.
 */
export function findRun(store: RunStore, kind: RunState['kind'], id: string): RunState {
  const noun = kind === 'import' ? 'import' : 'migration'
  store.prune()
  const state = id === 'last' ? store.list().find((r) => r.kind === kind) : store.load(id)
  if (!state && id === 'last') throw new UsageError(`There are no unfinished ${noun}s`)
  if (state && state.kind !== kind) {
    const other = state.kind === 'import' ? 'an import' : 'a migration'
    throw new UsageError(`Run ${id} is ${other}; continue it with "sple ${state.kind} --resume ${id}"`)
  }
  if (!state) {
    const runs = store.list().filter((r) => r.kind === kind)
    const listing = runs.map((r) => `\n  ${r.runId}  ${describeRun(r)}`)
    throw new UsageError(`No unfinished ${noun} '${id}'` + (runs.length > 0 ? `. Unfinished ${noun}s:${listing.join('')}` : ''))
  }
  return state
}

export function resumeHint(ctx: CommandContext, command: 'import' | 'migrate', state: RunState): void {
  ctx.io.err(`sple: ${command} stopped; resume with: sple ${command} --resume ${state.runId}`)
}

/**
 * Report a stop while writing: where the playlist is, if it was created, and
 * how to resume. Returns the error the CLI should report (the provider's cause).
 */
export function stopped(ctx: CommandContext, command: 'import' | 'migrate', state: RunState, error: unknown): unknown {
  if (error instanceof PlaylistAddTracksError) {
    // The playlist exists; say where, then let the CLI report the provider error and its exit code.
    ctx.io.err(`sple: playlist ${error.playlistUrl ?? error.playlistId} was created, but adding tracks failed`)
    resumeHint(ctx, command, state)
    return error.cause ?? error
  }
  resumeHint(ctx, command, state)
  return error
}

/**
 * Print the quota the remaining work needs, for targets with a daily quota
 * (FR-MIG-5, ADR 0002 Amendment 5). Returns the estimate, if any.
 */
export function printEstimate(
  ctx: CommandContext,
  provider: Provider,
  items: RunItem[],
  cache: MatchCache | undefined,
  dryRun: boolean
): QuotaEstimate | undefined {
  const caps = provider.capabilities
  if (caps.quotaModel.kind !== 'daily-buckets') return undefined
  const used = new QuotaLedger(provider.id, caps.quotaModel.buckets, { configDir: ctx.config.configDir }).used()
  const estimate = estimateQuota(countImportWork(items, provider.id, caps, cache, { dryRun }), caps, used)
  if (!estimate || estimate.days === 0) return estimate
  const parts = estimate.buckets
    .filter((b) => b.need > 0)
    .map((b) => `${b.bucket} up to ${b.need} (${b.remainingToday} of ${b.dailyLimit} left today)`)
  ctx.io.err(`Quota estimate for ${provider.id}: ${parts.join('; ')}`)
  if (estimate.days > 1) {
    ctx.io.err(
      `That needs about ${estimate.days} days of quota. sple stops when today's quota runs out ` +
        `(it resets at ${estimate.resetAt}) and prints how to resume.`
    )
  }
  return estimate
}
