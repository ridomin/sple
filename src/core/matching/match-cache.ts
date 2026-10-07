import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config/paths.js'
import type { CanonicalTrack, MatchCandidate } from '../provider/provider.js'

export const MATCH_CACHE_FILE = 'match-cache.json'
const SCHEMA_VERSION = 1

/**
 * YouTube API Developer Policies III.E.4: API data may be stored for at most
 * 30 days without a refresh (ADR 0002 §4.1). Applied to every provider.
 */
export const MATCH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface CacheEntry {
  ref: string
  title: string
  artists: string[]
  durationMs?: number
  confidence: number
  strategy: 'isrc' | 'metadata'
  fetchedAt: string
}

/** `targets[targetProvider]["<sourceProvider>|<sourceRef>"]` (ADR 0009 Amendment 2). */
interface CacheFile {
  schemaVersion: typeof SCHEMA_VERSION
  targets: Record<string, Record<string, CacheEntry>>
}

export interface MatchCacheOptions {
  /** Directory holding `match-cache.json`; defaults to the config directory. */
  configDir?: string
  now?: () => Date
}

/** One key per ref the source track has for a provider other than the target. */
function sourceKeys(track: CanonicalTrack, target: string): string[] {
  return Object.entries(track.refs ?? {})
    .filter(([provider, ref]) => provider !== target && typeof ref === 'string' && ref !== '')
    .map(([provider, ref]) => `${provider}|${ref}`)
}

function isEntry(value: unknown): value is CacheEntry {
  const e = value as CacheEntry
  return (
    typeof e === 'object' && e !== null &&
    typeof e.ref === 'string' && e.ref !== '' &&
    typeof e.title === 'string' &&
    Array.isArray(e.artists) && e.artists.every((a) => typeof a === 'string') &&
    (e.durationMs === undefined || typeof e.durationMs === 'number') &&
    typeof e.confidence === 'number' &&
    (e.strategy === 'isrc' || e.strategy === 'metadata') &&
    !Number.isNaN(Date.parse(e.fetchedAt))
  )
}

function readCacheFile(dir: string): CacheFile {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, MATCH_CACHE_FILE), 'utf8')) as CacheFile
    if (parsed.schemaVersion === SCHEMA_VERSION && typeof parsed.targets === 'object' && parsed.targets !== null) {
      return parsed
    }
  } catch {
    // Missing or unreadable: an empty cache costs searches, never correctness.
  }
  return { schemaVersion: SCHEMA_VERSION, targets: {} }
}

function writeCacheFile(dir: string, file: CacheFile): void {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, MATCH_CACHE_FILE)
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, target)
}

/**
 * Matches found by searching, reused by later imports so they cost no search
 * (FR-MIG-2 strategy "known ref from the match cache", ADR 0009 Amendment 2).
 * Entries expire 30 days after they were fetched; reading one doesn't extend it.
 */
export class MatchCache {
  private readonly dir: string
  private readonly now: () => Date
  private file?: CacheFile

  constructor(opts: MatchCacheOptions = {}) {
    this.dir = opts.configDir ?? getConfigDir()
    this.now = opts.now ?? (() => new Date())
  }

  /** The cached candidate for `track` on `target`, as a `cache` candidate, or undefined. */
  get(target: string, track: CanonicalTrack): MatchCandidate | undefined {
    const entries = this.load().targets[target]
    if (!entries) return undefined
    for (const key of sourceKeys(track, target)) {
      const entry = entries[key]
      if (isEntry(entry) && this.fresh(entry)) {
        return {
          ref: entry.ref,
          track: {
            title: entry.title,
            artists: [...entry.artists],
            ...(entry.durationMs !== undefined && { durationMs: entry.durationMs }),
            refs: { [target]: entry.ref },
          },
          confidence: entry.confidence,
          strategy: 'cache',
        }
      }
    }
    return undefined
  }

  /** Store a searched candidate under every source key of `track`, and save at once (searches are the scarce resource). */
  put(target: string, track: CanonicalTrack, candidate: MatchCandidate): void {
    if (candidate.strategy !== 'isrc' && candidate.strategy !== 'metadata') return
    const keys = sourceKeys(track, target)
    if (keys.length === 0) return

    const entry: CacheEntry = {
      ref: candidate.ref,
      title: candidate.track.title,
      artists: [...candidate.track.artists],
      ...(candidate.track.durationMs !== undefined && { durationMs: candidate.track.durationMs }),
      confidence: candidate.confidence,
      strategy: candidate.strategy,
      fetchedAt: this.now().toISOString(),
    }
    const file = this.load()
    const entries = (file.targets[target] ??= {})
    for (const key of keys) entries[key] = entry
    this.prune(file)
    writeCacheFile(this.dir, file)
  }

  private load(): CacheFile {
    this.file ??= readCacheFile(this.dir)
    return this.file
  }

  private fresh(entry: CacheEntry): boolean {
    return this.now().getTime() - Date.parse(entry.fetchedAt) < MATCH_CACHE_TTL_MS
  }

  private prune(file: CacheFile): void {
    for (const [target, entries] of Object.entries(file.targets)) {
      for (const [key, entry] of Object.entries(entries)) {
        if (!isEntry(entry) || !this.fresh(entry)) delete entries[key]
      }
      if (Object.keys(entries).length === 0) delete file.targets[target]
    }
  }
}

/**
 * Delete every entry that targets `providerId` or is keyed by one of its refs
 * (logout, NFR-9). Returns the number of entries removed; writes only if any were.
 */
export function removeCachedMatches(providerId: string, opts: { configDir?: string } = {}): number {
  const dir = opts.configDir ?? getConfigDir()
  const file = readCacheFile(dir)
  let removed = 0
  for (const [target, entries] of Object.entries(file.targets)) {
    for (const key of Object.keys(entries)) {
      if (target === providerId || key.startsWith(`${providerId}|`)) {
        delete entries[key]
        removed++
      }
    }
    if (Object.keys(entries).length === 0) delete file.targets[target]
  }
  if (removed > 0) writeCacheFile(dir, file)
  return removed
}
