import type { Provider } from '../provider/provider.js'
import type { MatchReport } from '../matching/types.js'
import { MatchingEngine } from '../matching/matching-engine.js'
import type { MatchCache } from '../matching/match-cache.js'
import { PlaylistCreator, matchedRefs, type PlaylistCreationResult } from './playlist-creator.js'
import type { RunItem, RunState, RunStore } from './run-store.js'

/**
 * Match the item's remaining tracks on `provider`, saving the run after every
 * track (ADR 0007 Amendment 4). A no-op once the item is past `matching`.
 */
export async function matchRunItem(
  provider: Provider,
  store: RunStore,
  state: RunState,
  item: RunItem,
  cache?: MatchCache,
  /** Called after each matched track with the number of tracks matched so far. */
  onProgress?: (matched: number, total: number) => void
): Promise<MatchReport> {
  if (item.phase !== 'matching') return item.report!
  const report = await new MatchingEngine({ cache }).match(item.file, provider, provider.capabilities, {
    minConfidence: state.options.minConfidence,
    sourceFilePath: item.sourceFilePath,
    targetPlaylistName: item.name,
    previous: item.results,
    onResult: (result) => {
      item.results.push(result)
      store.save(state)
      onProgress?.(item.results.length, item.file.tracks.length)
    },
  })
  item.report = report
  item.phase = 'matched'
  item.toAdd = matchedRefs(report)
  store.save(state)
  return report
}

/**
 * Create the item's private playlist (unless it exists) and add the rest of
 * `toAdd`, saving after creation and after each batch. Resuming in `adding`
 * reconciles against the playlist's track count first.
 */
export async function writeRunItem(
  provider: Provider,
  store: RunStore,
  state: RunState,
  item: RunItem
): Promise<PlaylistCreationResult> {
  const reconcile = item.phase === 'adding'
  item.phase = 'adding'
  store.save(state)
  const result = await new PlaylistCreator().writeMatches(provider, item, item.name, {
    checkpoint: () => store.save(state),
    reconcile,
  })
  item.phase = 'done'
  store.save(state)
  return result
}
