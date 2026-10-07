import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countImportWork, estimateQuota } from '../../../src/core/quota/estimate.js'
import { newRunItem } from '../../../src/core/import/run-store.js'
import type { CanonicalPlaylistFile } from '../../../src/core/export/format.js'
import type { ProviderCapabilities, QuotaModel } from '../../../src/core/provider/capabilities.js'
import type { CanonicalTrack, MatchCandidate } from '../../../src/core/provider/provider.js'
import { YOUTUBE_QUOTA_MODEL } from '../../../src/providers/youtube-music/quota.js'

const caps = (over: Partial<ProviderCapabilities> = {}) =>
  ({ isrcSearchMode: 'none', maxTracksPerRequest: 1, quotaModel: YOUTUBE_QUOTA_MODEL, ...over }) as ProviderCapabilities

function file(tracks: Array<Partial<CanonicalTrack>>): CanonicalPlaylistFile {
  return {
    schemaVersion: 1,
    exportedAt: '2026-10-07T00:00:00.000Z',
    generator: { name: 'sple', version: '0' },
    source: { provider: 'spotify', kind: 'playlist' },
    playlist: { name: 'P', trackCount: tracks.length },
    tracks: tracks.map((t, i) => ({ position: i + 1, title: `Song ${i + 1}`, artists: ['A'], refs: { spotify: `spotify:track:${i + 1}` }, ...t })),
    unsupportedItems: [],
  }
}

const noCache = { get: () => undefined }

test('countImportWork: a search per track without a target ref or cache entry, a playlist, and an insert per track', () => {
  const cached: MatchCandidate = { ref: 'v', track: { title: '', artists: [], refs: {} }, confidence: 1, strategy: 'cache' }
  const f = file([{}, { refs: { 'youtube-music': 'known' } }, { refs: { spotify: 'spotify:track:cached' } }, {}])
  const cache = { get: (_t: string, track: CanonicalTrack) => (track.refs.spotify === 'spotify:track:cached' ? cached : undefined) }
  const work = countImportWork([newRunItem(f, { name: 'P', sourceFilePath: 'p.json' })], 'youtube-music', caps(), cache)
  assert.deepEqual(work, { searchCalls: 2, playlists: 1, inserts: 4 })
})

test('countImportWork: ISRC adds a search only where the target can search by ISRC; untitled tracks need no metadata search', () => {
  const f = file([{ isrc: 'USRC17607839', refs: { fake: 'fake:track:1' } }, { title: '', refs: { fake: 'fake:track:2' } }])
  const item = newRunItem(f, { name: 'P', sourceFilePath: 'p.json' })
  assert.equal(countImportWork([item], 'spotify', caps({ isrcSearchMode: 'filter' }), noCache).searchCalls, 2)
  assert.equal(countImportWork([item], 'youtube-music', caps(), noCache).searchCalls, 1)
})

test('countImportWork: a dry run creates and adds nothing', () => {
  const item = newRunItem(file([{}, {}]), { name: 'P', sourceFilePath: 'p.json' })
  assert.deepEqual(countImportWork([item], 'youtube-music', caps(), noCache, { dryRun: true }), { searchCalls: 2, playlists: 0, inserts: 0 })
})

test('countImportWork: a resumed run counts only what is left', () => {
  const matching = newRunItem(file([{}, {}, {}]), { name: 'P', sourceFilePath: 'p.json' })
  matching.results = [{ position: 1, track: matching.file.tracks[0], status: 'unmatched', strategies: [] }]
  assert.deepEqual(countImportWork([matching], 'youtube-music', caps(), noCache), { searchCalls: 2, playlists: 1, inserts: 2 })

  const adding = newRunItem(file([{}, {}, {}]), { name: 'P', sourceFilePath: 'p.json' })
  Object.assign(adding, { phase: 'adding', playlist: { id: 'x', ref: 'x', name: 'P' }, toAdd: ['a', 'b', 'c'], cursor: 1 })
  assert.deepEqual(countImportWork([adding], 'youtube-music', caps(), noCache), { searchCalls: 0, playlists: 0, inserts: 2 })

  const matched = { ...newRunItem(file([{}, {}]), { name: 'P', sourceFilePath: 'p.json' }), phase: 'matched' as const, toAdd: ['a'] }
  assert.deepEqual(countImportWork([matched], 'youtube-music', caps(), noCache), { searchCalls: 0, playlists: 1, inserts: 1 })
})

test('estimateQuota: converts work to buckets with the declared costs and today’s usage', () => {
  const now = new Date('2026-10-07T20:00:00.000Z') // 13:00 Pacific
  const e = estimateQuota({ searchCalls: 120, playlists: 1, inserts: 120 }, caps(), { units: 24, search: 4 }, now)!
  assert.deepEqual(e.buckets, [
    { bucket: 'units', need: 120 + 50 + 120 * 50, remainingToday: 9976, dailyLimit: 10_000 },
    { bucket: 'search', need: 120, remainingToday: 96, dailyLimit: 100 },
  ])
  assert.equal(e.days, 2)
  assert.equal(e.resetAt, '2026-10-08T07:00:00.000Z')
})

test('estimateQuota: days follow the most constrained bucket', () => {
  const now = new Date('2026-10-07T20:00:00.000Z')
  assert.equal(estimateQuota({ searchCalls: 50, playlists: 1, inserts: 50 }, caps(), {}, now)!.days, 1)
  assert.equal(estimateQuota({ searchCalls: 0, playlists: 1, inserts: 450 }, caps(), {}, now)!.days, 3, '22,550 units')
  assert.equal(estimateQuota({ searchCalls: 0, playlists: 1, inserts: 100 }, caps(), { units: 9_000 }, now)!.days, 2)
  assert.equal(estimateQuota({ searchCalls: 0, playlists: 0, inserts: 0 }, caps(), {}, now)!.days, 0)
})

test('estimateQuota: populate costs per call use batches of maxTracksPerRequest', () => {
  const model: QuotaModel = { kind: 'daily-buckets', buckets: [{ id: 'u', dailyLimit: 100, resetTimeZone: 'UTC' }], costs: { populatePlaylist: [{ bucket: 'u', amount: 1, per: 'call' }] } }
  const e = estimateQuota({ searchCalls: 0, playlists: 0, inserts: 250 }, caps({ quotaModel: model, maxTracksPerRequest: 100 }), {}, new Date())!
  assert.equal(e.buckets[0].need, 3)
})

test('estimateQuota: undefined for providers without daily buckets', () => {
  assert.equal(estimateQuota({ searchCalls: 9, playlists: 1, inserts: 9 }, caps({ quotaModel: { kind: 'rate-limited' } }), {}, new Date()), undefined)
})
