import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QuotaLedger, quotaDay, nextReset } from '../../../src/core/quota/ledger.js'
import { QuotaExhaustedError } from '../../../src/core/provider/errors.js'
import { getExitCode, EXIT_CODES } from '../../../src/cli/exit-codes.js'

const PT = 'America/Los_Angeles'
const BUCKETS = [
  { id: 'units', dailyLimit: 100, resetTimeZone: PT },
  { id: 'search', dailyLimit: 3, resetTimeZone: PT },
]
const freshDir = () => mkdtempSync(join(tmpdir(), 'sple-ledger-'))
const at = (iso: string) => () => new Date(iso)

test('quotaDay and nextReset follow the Pacific calendar, across DST', () => {
  assert.equal(quotaDay(new Date('2026-10-07T10:00:00Z'), PT), '2026-10-07')
  assert.equal(quotaDay(new Date('2026-10-08T06:59:59Z'), PT), '2026-10-07') // 23:59:59 PDT
  assert.equal(nextReset(new Date('2026-10-07T10:00:00Z'), PT).toISOString(), '2026-10-08T07:00:00.000Z') // PDT
  // DST ends 2026-11-01 at 02:00 PDT: the next midnight is PST (UTC-8).
  assert.equal(nextReset(new Date('2026-11-01T07:30:00Z'), PT).toISOString(), '2026-11-02T08:00:00.000Z')
})

test('charges accumulate per bucket and persist across instances', () => {
  const dir = freshDir()
  const now = at('2026-10-07T10:00:00Z')
  new QuotaLedger('youtube-music', BUCKETS, { configDir: dir, now }).charge('units', 50)
  const ledger = new QuotaLedger('youtube-music', BUCKETS, { configDir: dir, now })
  ledger.charge('units', 1)
  ledger.charge('search', 1)
  assert.deepStrictEqual(ledger.used(), { units: 51, search: 1 })
  const file = JSON.parse(readFileSync(join(dir, 'quota.json'), 'utf8'))
  assert.deepStrictEqual(file.providers['youtube-music'], { day: '2026-10-07', used: { units: 51, search: 1 } })
})

test('a charge that would overdraw is refused with QuotaExhaustedError (exit 5) and not recorded', () => {
  const dir = freshDir()
  const ledger = new QuotaLedger('youtube-music', BUCKETS, { configDir: dir, now: at('2026-10-07T10:00:00Z') })
  ledger.charge('units', 99)
  assert.throws(
    () => ledger.charge('units', 2),
    (e: unknown) =>
      e instanceof QuotaExhaustedError &&
      e.bucket === 'units' &&
      e.resetAt?.toISOString() === '2026-10-08T07:00:00.000Z' &&
      getExitCode(e) === EXIT_CODES.QUOTA_EXHAUSTED
  )
  assert.equal(ledger.used().units, 99)
  ledger.charge('units', 1) // exactly the limit is allowed
})

test('a new Pacific day starts from zero', () => {
  const dir = freshDir()
  new QuotaLedger('youtube-music', BUCKETS, { configDir: dir, now: at('2026-10-07T10:00:00Z') }).charge('search', 3)
  const nextDay = new QuotaLedger('youtube-music', BUCKETS, { configDir: dir, now: at('2026-10-08T07:00:00Z') })
  assert.deepStrictEqual(nextDay.used(), {})
  nextDay.charge('search', 3)
})

test('markExhausted refuses further charges for the rest of the day', () => {
  const dir = freshDir()
  const ledger = new QuotaLedger('youtube-music', BUCKETS, { configDir: dir, now: at('2026-10-07T10:00:00Z') })
  ledger.markExhausted('units')
  assert.throws(() => ledger.charge('units', 1), QuotaExhaustedError)
  ledger.charge('search', 1) // other buckets are unaffected
})

test('unknown buckets are a programming error', () => {
  const ledger = new QuotaLedger('youtube-music', BUCKETS, { configDir: freshDir() })
  assert.throws(() => ledger.charge('nope', 1), /Unknown quota bucket/)
})
