import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderId, QuotaBucket } from '../provider/capabilities.js'
import { QuotaExhaustedError } from '../provider/errors.js'
import { getConfigDir } from '../config/paths.js'

const LEDGER_FILE = 'quota.json'
const SCHEMA_VERSION = 1

interface ProviderUsage {
  /** Calendar day in the buckets' reset time zone, `YYYY-MM-DD`. */
  day: string
  used: Record<string, number>
}

interface LedgerFile {
  schemaVersion: number
  providers: Partial<Record<ProviderId, ProviderUsage>>
}

/** The calendar day of `at` in `timeZone`, as `YYYY-MM-DD`. */
export function quotaDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** Milliseconds `timeZone` is ahead of UTC at instant `t`. */
function zoneOffsetMs(t: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(t)).map((p) => [p.type, Number(p.value)])
  )
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return wall - Math.floor(t / 1000) * 1000
}

/** The next midnight in `timeZone` after `at` (the quota reset), DST-aware. */
export function nextReset(at: Date, timeZone: string): Date {
  const [y, m, d] = quotaDay(at, timeZone).split('-').map(Number)
  const midnightWall = Date.UTC(y, m - 1, d + 1)
  // Two passes: the offset at the guessed instant can differ from the one at `at` across DST.
  let utc = midnightWall - zoneOffsetMs(at.getTime(), timeZone)
  utc = midnightWall - zoneOffsetMs(utc, timeZone)
  return new Date(utc)
}

export interface QuotaLedgerOptions {
  /** Directory holding `quota.json`; defaults to the config directory (next to tokens.json). */
  configDir?: string
  now?: () => Date
}

/**
 * Per-day quota ledger for a provider with `daily-buckets` (PRV-4, ADR 0002 §4.1).
 * Calls are charged *before* they are sent, because failed calls cost quota too.
 * State lives in `quota.json`; concurrent processes are not locked against.
 */
export class QuotaLedger {
  private readonly dir: string
  private readonly now: () => Date
  private readonly timeZone: string

  constructor(
    private readonly providerId: ProviderId,
    private readonly buckets: readonly QuotaBucket[],
    opts: QuotaLedgerOptions = {}
  ) {
    this.dir = opts.configDir ?? getConfigDir()
    this.now = opts.now ?? (() => new Date())
    // ADR 0002 buckets share one reset zone; the first one decides the day.
    this.timeZone = buckets[0]?.resetTimeZone ?? 'UTC'
  }

  /** Today's usage per bucket (buckets not yet charged are absent). */
  used(): Record<string, number> {
    return { ...this.today().used }
  }

  /** Record `amount` against `bucket`, or throw QuotaExhaustedError if it would exceed the daily limit. */
  charge(bucket: string, amount: number): void {
    const limit = this.limit(bucket)
    const usage = this.today()
    const used = usage.used[bucket] ?? 0
    if (used + amount > limit) {
      throw new QuotaExhaustedError(
        `${this.providerId} daily quota for '${bucket}' is used up (${used}/${limit}); it resets at midnight Pacific Time`,
        bucket,
        nextReset(this.now(), this.timeZone)
      )
    }
    usage.used[bucket] = used + amount
    this.save(usage)
  }

  /** The provider reported the bucket exhausted: refuse further charges until the reset. */
  markExhausted(bucket: string): void {
    const usage = this.today()
    usage.used[bucket] = this.limit(bucket)
    this.save(usage)
  }

  private limit(bucket: string): number {
    const b = this.buckets.find((x) => x.id === bucket)
    if (!b) throw new Error(`Unknown quota bucket '${bucket}' for ${this.providerId}`)
    return b.dailyLimit
  }

  private read(): LedgerFile {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, LEDGER_FILE), 'utf8')) as LedgerFile
      if (parsed.schemaVersion === SCHEMA_VERSION && parsed.providers && typeof parsed.providers === 'object') {
        return parsed
      }
    } catch {
      // Missing or unreadable: start a new ledger (worst case, quota is under-counted for one day).
    }
    return { schemaVersion: SCHEMA_VERSION, providers: {} }
  }

  private today(): ProviderUsage {
    const day = quotaDay(this.now(), this.timeZone)
    const stored = this.read().providers[this.providerId]
    return stored && stored.day === day && stored.used && typeof stored.used === 'object'
      ? { day, used: { ...stored.used } }
      : { day, used: {} }
  }

  private save(usage: ProviderUsage): void {
    const file = this.read()
    file.providers[this.providerId] = usage
    mkdirSync(this.dir, { recursive: true })
    const target = join(this.dir, LEDGER_FILE)
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, target)
  }
}
