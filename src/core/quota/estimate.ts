import type { ProviderCapabilities, ProviderOperation, QuotaCost } from '../provider/capabilities.js'
import type { CanonicalTrack, MatchCandidate } from '../provider/provider.js'
import type { RunItem } from '../import/run-store.js'
import { nextReset } from './ledger.js'

/** Provider calls an import will make, at most (ADR 0002 Amendment 5). */
export interface ImportWork {
  /** `searchTracks` calls: ISRC (where the target supports it) plus metadata, per track that needs a search. */
  searchCalls: number
  playlists: number
  /** Tracks to add: every track that may still be matched (an upper bound until matching ends). */
  inserts: number
}

export interface BucketEstimate {
  bucket: string
  need: number
  remainingToday: number
  dailyLimit: number
}

export interface QuotaEstimate {
  buckets: BucketEstimate[]
  /** Pacific (reset-zone) days needed from today, given today's usage; 0 when nothing is needed. */
  days: number
  /** The next quota reset, ISO 8601 UTC. */
  resetAt: string
}

/**
 * Count the calls the remaining work of `items` needs on `target`. A track
 * needs no search when the file has a ref for the target or the cache has a
 * fresh entry (ADR 0009 Amendment 2).
 */
export function countImportWork(
  items: RunItem[],
  target: string,
  capabilities: ProviderCapabilities,
  cache: { get(target: string, track: CanonicalTrack): MatchCandidate | undefined } | undefined,
  opts: { dryRun?: boolean } = {}
): ImportWork {
  const work: ImportWork = { searchCalls: 0, playlists: 0, inserts: 0 }
  for (const item of items) {
    if (item.phase === 'done') continue
    if (item.phase === 'matching') {
      const done = new Set(item.results.map((r) => r.position))
      const pending = item.file.tracks.filter((t) => !done.has(t.position))
      for (const track of pending) {
        if (track.refs?.[target] || cache?.get(target, track)) continue
        if (track.isrc && capabilities.isrcSearchMode !== 'none') work.searchCalls++
        if (track.title) work.searchCalls++
      }
      work.inserts += item.results.filter((r) => r.status === 'matched').length + pending.length
    } else {
      work.inserts += item.toAdd.length - item.cursor
    }
    if (!item.playlist) work.playlists++
  }
  if (opts.dryRun) {
    work.playlists = 0
    work.inserts = 0
  }
  return work
}

function units(cost: QuotaCost, calls: number, items: number, batch: number): number {
  switch (cost.per) {
    case 'item':
      return cost.amount * items
    case 'call':
      return cost.amount * (items === 0 ? calls : Math.ceil(items / batch))
    default:
      // 'page' costs are for reads, which an import doesn't page through.
      return 0
  }
}

/**
 * Turn `work` into per-bucket needs with the target's declared costs, and
 * compare them with today's usage (`used`, from the ledger). Undefined for
 * providers without daily buckets (FR-MIG-5).
 */
export function estimateQuota(
  work: ImportWork,
  capabilities: ProviderCapabilities,
  used: Record<string, number>,
  now: Date = new Date()
): QuotaEstimate | undefined {
  const model = capabilities.quotaModel
  if (model.kind !== 'daily-buckets') return undefined

  const need = new Map(model.buckets.map((b) => [b.id, 0]))
  const add = (op: ProviderOperation, calls: number, items: number) => {
    for (const cost of model.costs[op] ?? []) {
      need.set(cost.bucket, (need.get(cost.bucket) ?? 0) + units(cost, calls, items, Math.max(1, capabilities.maxTracksPerRequest)))
    }
  }
  add('searchTracks', work.searchCalls, 0)
  add('createPlaylist', work.playlists, 0)
  add('populatePlaylist', 0, work.inserts)

  const buckets = model.buckets.map((b) => ({
    bucket: b.id,
    need: need.get(b.id) ?? 0,
    remainingToday: Math.max(0, b.dailyLimit - (used[b.id] ?? 0)),
    dailyLimit: b.dailyLimit,
  }))
  const days = Math.max(
    0,
    ...buckets.map((b) =>
      b.need === 0 ? 0 : b.need <= b.remainingToday ? 1 : 1 + Math.ceil((b.need - b.remainingToday) / b.dailyLimit)
    )
  )
  const timeZone = model.buckets[0]?.resetTimeZone ?? 'UTC'
  return { buckets, days, resetAt: nextReset(now, timeZone).toISOString() }
}
