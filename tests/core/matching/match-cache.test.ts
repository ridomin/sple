import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatchCache, MATCH_CACHE_FILE, removeCachedMatches } from '../../../src/core/matching/match-cache.js'
import type { CanonicalTrack, MatchCandidate } from '../../../src/core/provider/provider.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-10-07T12:00:00.000Z')

const source: CanonicalTrack = {
  title: 'Song',
  artists: ['Artist'],
  durationMs: 200_000,
  refs: { spotify: 'spotify:track:abc' },
}

const candidate: MatchCandidate = {
  ref: 'dQw4w9WgXcQ',
  track: { title: 'Song (Official Video)', artists: ['Artist'], durationMs: 201_000, refs: { 'youtube-music': 'dQw4w9WgXcQ' } },
  confidence: 0.85,
  strategy: 'metadata',
}

const tempDir = () => mkdtempSync(join(tmpdir(), 'sple-match-cache-'))

test('a stored match is returned for the same source ref and target, with its original confidence', () => {
  const dir = tempDir()
  new MatchCache({ configDir: dir, now: () => T0 }).put('youtube-music', source, candidate)

  const later = new MatchCache({ configDir: dir, now: () => new Date(T0.getTime() + DAY) })
  const hit = later.get('youtube-music', source)
  assert.deepEqual(hit, {
    ref: 'dQw4w9WgXcQ',
    track: { title: 'Song (Official Video)', artists: ['Artist'], durationMs: 201_000, refs: { 'youtube-music': 'dQw4w9WgXcQ' } },
    confidence: 0.85,
    strategy: 'cache',
  })
  assert.equal(later.get('spotify', source), undefined, 'other targets do not share entries')
})

test('any non-target ref of the track finds the entry (a CSV may carry another provider ref)', () => {
  const dir = tempDir()
  const multi: CanonicalTrack = { ...source, refs: { spotify: 'spotify:track:abc', fake: 'fake:track:1' } }
  const cache = new MatchCache({ configDir: dir, now: () => T0 })
  cache.put('youtube-music', multi, candidate)

  assert.equal(cache.get('youtube-music', { ...source, refs: { fake: 'fake:track:1' } })?.ref, 'dQw4w9WgXcQ')
  assert.equal(cache.get('youtube-music', { ...source, refs: {} }), undefined, 'no refs, no key')
})

test('the target ref itself is never a key', () => {
  const dir = tempDir()
  const cache = new MatchCache({ configDir: dir, now: () => T0 })
  cache.put('youtube-music', { ...source, refs: { 'youtube-music': 'x' } }, candidate)
  assert.equal(existsSync(join(dir, MATCH_CACHE_FILE)), false, 'nothing to store')
})

test('entries expire 30 days after fetchedAt, and reading them does not extend that', () => {
  const dir = tempDir()
  new MatchCache({ configDir: dir, now: () => T0 }).put('youtube-music', source, candidate)

  const at = (ms: number) => new MatchCache({ configDir: dir, now: () => new Date(T0.getTime() + ms) })
  assert.ok(at(30 * DAY - 1).get('youtube-music', source))
  assert.equal(at(30 * DAY).get('youtube-music', source), undefined)
})

test('expired entries are pruned when the file is next written', () => {
  const dir = tempDir()
  new MatchCache({ configDir: dir, now: () => T0 }).put('youtube-music', source, candidate)
  const other: CanonicalTrack = { ...source, refs: { spotify: 'spotify:track:def' } }
  new MatchCache({ configDir: dir, now: () => new Date(T0.getTime() + 31 * DAY) }).put('youtube-music', other, candidate)

  const file = JSON.parse(readFileSync(join(dir, MATCH_CACHE_FILE), 'utf8'))
  assert.deepEqual(Object.keys(file.targets['youtube-music']), ['spotify|spotify:track:def'])
})

test('the file is versioned, user-only and holds no source metadata', () => {
  const dir = tempDir()
  new MatchCache({ configDir: dir, now: () => T0 }).put('youtube-music', source, candidate)
  const path = join(dir, MATCH_CACHE_FILE)
  const file = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(file, {
    schemaVersion: 1,
    targets: {
      'youtube-music': {
        'spotify|spotify:track:abc': {
          ref: 'dQw4w9WgXcQ',
          title: 'Song (Official Video)',
          artists: ['Artist'],
          durationMs: 201_000,
          confidence: 0.85,
          strategy: 'metadata',
          fetchedAt: T0.toISOString(),
        },
      },
    },
  })
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('a missing, corrupt or unknown-version file is an empty cache', () => {
  const dir = tempDir()
  const path = join(dir, MATCH_CACHE_FILE)
  assert.equal(new MatchCache({ configDir: dir }).get('youtube-music', source), undefined)
  writeFileSync(path, '{not json')
  assert.equal(new MatchCache({ configDir: dir }).get('youtube-music', source), undefined)
  writeFileSync(path, JSON.stringify({ schemaVersion: 2, targets: {} }))
  assert.equal(new MatchCache({ configDir: dir }).get('youtube-music', source), undefined)
})

test('malformed entries are ignored', () => {
  const dir = tempDir()
  writeFileSync(
    join(dir, MATCH_CACHE_FILE),
    JSON.stringify({ schemaVersion: 1, targets: { 'youtube-music': { 'spotify|spotify:track:abc': { ref: 42, fetchedAt: 'never' } } } })
  )
  assert.equal(new MatchCache({ configDir: dir, now: () => T0 }).get('youtube-music', source), undefined)
})

test('removeCachedMatches deletes entries targeting or keyed by a provider', () => {
  const dir = tempDir()
  const cache = new MatchCache({ configDir: dir, now: () => T0 })
  cache.put('youtube-music', source, candidate)
  const fromYouTube: CanonicalTrack = { ...source, refs: { 'youtube-music': 'abcdefghijk' } }
  cache.put('spotify', fromYouTube, { ...candidate, ref: 'spotify:track:zzz' })
  cache.put('spotify', { ...source, refs: { fake: 'fake:track:1' } }, { ...candidate, ref: 'spotify:track:yyy' })

  assert.equal(removeCachedMatches('youtube-music', { configDir: dir }), 2)
  const file = JSON.parse(readFileSync(join(dir, MATCH_CACHE_FILE), 'utf8'))
  assert.deepEqual(file.targets, { spotify: { 'fake|fake:track:1': file.targets.spotify['fake|fake:track:1'] } })
  assert.equal(removeCachedMatches('youtube-music', { configDir: dir }), 0)
})

test('removeCachedMatches does not create a file', () => {
  const dir = tempDir()
  assert.equal(removeCachedMatches('youtube-music', { configDir: dir }), 0)
  assert.equal(existsSync(join(dir, MATCH_CACHE_FILE)), false)
})
