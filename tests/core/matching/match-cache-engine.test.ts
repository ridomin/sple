import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatchingEngine } from '../../../src/core/matching/matching-engine.js'
import { MatchCache } from '../../../src/core/matching/match-cache.js'
import { CacheStrategy } from '../../../src/core/matching/strategies/cache-strategy.js'
import type { Provider, TrackHit, TrackQuery } from '../../../src/core/provider/provider.js'
import type { ProviderCapabilities } from '../../../src/core/provider/capabilities.js'
import type { CanonicalPlaylistFile } from '../../../src/core/export/format.js'

const capabilities = { isrcSearchMode: 'none' } as ProviderCapabilities

/** A target whose searchTracks returns `hits` and records every query. */
// The hit's duration is 16 s off, so it scores 0.85, not 1.
function target(hits: TrackHit[] = [{ ref: 'vid00000001', track: { title: 'Imagine', artists: ['John Lennon'], durationMs: 199_000, refs: {} } }]) {
  const queries: TrackQuery[] = []
  const provider = {
    id: 'youtube-music',
    capabilities,
    searchTracks: async (q: TrackQuery) => {
      queries.push(q)
      return hits
    },
  } as unknown as Provider
  return { provider, queries }
}

function file(tracks: CanonicalPlaylistFile['tracks']): CanonicalPlaylistFile {
  return {
    schemaVersion: 1,
    exportedAt: '2026-10-07T00:00:00.000Z',
    generator: { name: 'sple', version: '0.1.0' },
    source: { provider: 'spotify', kind: 'playlist' },
    playlist: { name: 'P', trackCount: tracks.length },
    tracks,
    unsupportedItems: [],
  }
}

const imagine = { position: 1, title: 'Imagine', artists: ['John Lennon'], durationMs: 183_000, refs: { spotify: 'spotify:track:1' } }
const tempCache = () => new MatchCache({ configDir: mkdtempSync(join(tmpdir(), 'sple-engine-cache-')) })

test('a second import of the same track uses the cache and sends no search', async () => {
  const cache = tempCache()
  const first = target()
  const r1 = await new MatchingEngine({ cache }).match(file([imagine]), first.provider, capabilities)
  assert.equal(first.queries.length, 1)
  assert.equal(r1.results[0].candidate?.strategy, 'metadata')

  const second = target()
  const r2 = await new MatchingEngine({ cache }).match(file([imagine]), second.provider, capabilities)
  assert.equal(second.queries.length, 0, 'no search')
  assert.equal(r2.results[0].status, 'matched')
  assert.deepEqual(r2.results[0].strategies, ['known-ref', 'cache'])
  assert.equal(r2.results[0].candidate?.ref, 'vid00000001')
  assert.equal(r2.results[0].confidence, r1.results[0].confidence, 'original confidence kept')
})

test('--min-confidence applies again to a cached candidate', async () => {
  const cache = tempCache()
  await new MatchingEngine({ cache }).match(file([imagine]), target().provider, capabilities)
  const strict = await new MatchingEngine({ cache }).match(file([imagine]), target().provider, capabilities, { minConfidence: 1 })
  assert.equal(strict.results[0].status, 'low-confidence')
  assert.equal(strict.results[0].candidate?.strategy, 'cache')
})

test('low-confidence candidates are cached too; unmatched tracks are not', async () => {
  const cache = tempCache()
  await new MatchingEngine({ cache }).match(file([imagine]), target().provider, capabilities, { minConfidence: 1 })
  assert.ok(cache.get('youtube-music', imagine), 'low-confidence candidate cached')

  const nothing = target([])
  const other = { ...imagine, refs: { spotify: 'spotify:track:2' } }
  await new MatchingEngine({ cache }).match(file([other]), nothing.provider, capabilities)
  assert.equal(cache.get('youtube-music', other), undefined)
})

test('a ref for the target in the file wins over the cache', async () => {
  const cache = tempCache()
  await new MatchingEngine({ cache }).match(file([imagine]), target().provider, capabilities)
  const withRef = { ...imagine, refs: { ...imagine.refs, 'youtube-music': 'fromFile123' } }
  const r = await new MatchingEngine({ cache }).match(file([withRef]), target().provider, capabilities)
  assert.equal(r.results[0].candidate?.ref, 'fromFile123')
  assert.deepEqual(r.results[0].strategies, ['known-ref'])
})

test('without a cache the engine neither reads nor writes one', async () => {
  const cache = tempCache()
  await new MatchingEngine({ cache }).match(file([imagine]), target().provider, capabilities)
  const t = target()
  const r = await new MatchingEngine().match(file([imagine]), t.provider, capabilities)
  assert.equal(t.queries.length, 1)
  assert.deepEqual(r.results[0].strategies, ['known-ref', 'metadata'])
})

test('strategy order: known-ref, cache, isrc, metadata', () => {
  assert.equal(new CacheStrategy(tempCache()).priority, 2)
  assert.equal(new CacheStrategy(tempCache()).name, 'cache')
})
