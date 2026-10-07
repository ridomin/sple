import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunStore, RUNS_DIR, newRunItem, type RunItem } from '../../../src/core/import/run-store.js'
import type { CanonicalPlaylistFile } from '../../../src/core/export/format.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-10-07T12:00:00.000Z')

function file(provider: CanonicalPlaylistFile['source']['provider'] = 'spotify'): CanonicalPlaylistFile {
  return {
    schemaVersion: 1,
    exportedAt: T0.toISOString(),
    generator: { name: 'sple', version: '0.1.0' },
    source: { provider, kind: 'playlist' },
    playlist: { name: 'Road trip', trackCount: 0 },
    tracks: [],
    unsupportedItems: [],
  }
}

const item = (provider?: CanonicalPlaylistFile['source']['provider']): RunItem => newRunItem(file(provider), { name: 'Road trip', sourceFilePath: 'trip.json' })
const tempDir = () => mkdtempSync(join(tmpdir(), 'sple-runs-'))

test('create assigns an ID, saves the run with mode 0600 and loads it back', () => {
  const dir = tempDir()
  const store = new RunStore({ configDir: dir, now: () => T0 })
  const run = store.create('import', 'youtube-music', { minConfidence: 0.5, cache: true }, [item()])

  assert.match(run.runId, /^20261007-[0-9a-f]{6}$/)
  const path = join(dir, RUNS_DIR, `${run.runId}.json`)
  assert.ok(existsSync(path))
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, RUNS_DIR)).mode & 0o777, 0o700)
  }
  const loaded = store.load(run.runId)
  assert.deepEqual(loaded, run)
  assert.equal(loaded?.items[0].phase, 'matching')
  assert.equal(loaded?.createdAt, T0.toISOString())
})

test('save records progress and updatedAt', () => {
  const dir = tempDir()
  let now = T0
  const store = new RunStore({ configDir: dir, now: () => now })
  const run = store.create('import', 'youtube-music', { minConfidence: 0.5, cache: true }, [item()])
  now = new Date(T0.getTime() + 1000)
  run.items[0].phase = 'matched'
  store.save(run)
  const loaded = store.load(run.runId)!
  assert.equal(loaded.items[0].phase, 'matched')
  assert.equal(loaded.updatedAt, now.toISOString())
})

test('IDs that are not run IDs are never used as paths', () => {
  const store = new RunStore({ configDir: tempDir() })
  for (const id of ['../tokens', '20261007-abcdef/../../x', '', 'tokens']) {
    assert.equal(store.load(id), undefined, id)
  }
})

test('runs older than 30 days are gone: load misses them and prune deletes them', () => {
  const dir = tempDir()
  const old = new RunStore({ configDir: dir, now: () => T0 }).create('import', 'youtube-music', { minConfidence: 0.5, cache: true }, [item()])
  const later = new RunStore({ configDir: dir, now: () => new Date(T0.getTime() + 30 * DAY) })
  assert.equal(later.load(old.runId), undefined)
  assert.equal(later.prune(), 1)
  assert.deepEqual(readdirSync(join(dir, RUNS_DIR)), [])
})

test('list returns unfinished runs, newest first; corrupt files are skipped', () => {
  const dir = tempDir()
  let now = T0
  const store = new RunStore({ configDir: dir, now: () => now })
  const a = store.create('import', 'youtube-music', { minConfidence: 0.5, cache: true }, [item()])
  now = new Date(T0.getTime() + 1000)
  const b = store.create('migrate', 'spotify', { minConfidence: 0.5, cache: true }, [item()])
  writeFileSync(join(dir, RUNS_DIR, '20261007-000000.json'), '{nope')
  assert.deepEqual(store.list().map((r) => r.runId), [b.runId, a.runId])
})

test('delete removes the run file; deleting twice is fine', () => {
  const dir = tempDir()
  const store = new RunStore({ configDir: dir })
  const run = store.create('import', 'youtube-music', { minConfidence: 0.5, cache: true }, [item()])
  store.delete(run.runId)
  store.delete(run.runId)
  assert.equal(store.load(run.runId), undefined)
})

test('removeForProvider deletes runs targeting it or reading from it', () => {
  const dir = tempDir()
  const store = new RunStore({ configDir: dir })
  const toYouTube = store.create('import', 'youtube-music', { minConfidence: 0.5, cache: true }, [item('spotify')])
  const fromYouTube = store.create('import', 'spotify', { minConfidence: 0.5, cache: true }, [item('youtube-music')])
  const unrelated = store.create('import', 'spotify', { minConfidence: 0.5, cache: true }, [item('fake')])

  assert.equal(store.removeForProvider('youtube-music'), 2)
  assert.equal(store.load(toYouTube.runId), undefined)
  assert.equal(store.load(fromYouTube.runId), undefined)
  assert.ok(store.load(unrelated.runId))
})

test('a missing runs directory is an empty list, and removeForProvider creates nothing', () => {
  const dir = tempDir()
  const store = new RunStore({ configDir: dir })
  assert.deepEqual(store.list(), [])
  assert.equal(store.removeForProvider('spotify'), 0)
  assert.equal(store.prune(), 0)
  assert.equal(existsSync(join(dir, RUNS_DIR)), false)
})
