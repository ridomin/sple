import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatchingEngine } from '../../src/core/matching/matching-engine.js'
import { CanonicalFileReader } from '../../src/core/import/file-reader.js'
import { FakeProvider } from '../../src/providers/fake/index.js'
import type { CanonicalPlaylistFile } from '../../src/core/export/format.js'

function makeFile(
  tracks: CanonicalPlaylistFile['tracks'],
  unsupportedItems: CanonicalPlaylistFile['unsupportedItems'] = []
): CanonicalPlaylistFile {
  return {
    schemaVersion: 1,
    exportedAt: '2026-10-05T12:00:00Z',
    generator: { name: 'sple', version: '0.1.0' },
    source: { provider: 'spotify', kind: 'playlist' },
    playlist: {
      id: 'pl1',
      name: 'Test Playlist',
      trackCount: tracks.length + unsupportedItems.length,
    },
    tracks,
    unsupportedItems,
  }
}

describe('Import E2E (with fake provider)', () => {
  let engine: MatchingEngine
  let reader: CanonicalFileReader
  let provider: FakeProvider
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sple-import-e2e-'))
    engine = new MatchingEngine()
    reader = new CanonicalFileReader()
    const fakeTracks = [
      { id: 'f1', title: 'Song A', artists: ['Artist A'], album: 'Album A', duration: 180000 },
      { id: 'f2', title: 'Imagine', artists: ['John Lennon'], album: 'Imagine', duration: 183000 },
    ]
    provider = new FakeProvider({ initialTracks: fakeTracks })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('should match tracks from exported file to fake provider', async () => {
    const filePath = join(dir, 'export.json')
    await writeFile(
      filePath,
      JSON.stringify(
        makeFile([
          {
            position: 1,
            title: 'Song A',
            artists: ['Artist A'],
            album: 'Album A',
            durationMs: 180000,
            refs: {},
          },
          {
            position: 2,
            title: 'Imagine',
            artists: ['John Lennon'],
            durationMs: 183000,
            refs: { fake: 'f2' },
          },
        ])
      )
    )

    const file = await reader.readFile(filePath)
    const report = await engine.match(file, provider, provider.capabilities)

    assert.equal(report.summary.total, 2)
    assert.equal(report.summary.matched, 2)
    assert.equal(report.summary.unmatched, 0)
    assert.equal(report.results[1].confidence, 1)
    assert.deepEqual(report.results[1].strategies, ['known-ref'])
    assert.deepEqual(report.results[0].strategies, ['metadata'])
  })

  test('should handle mixed matched, unmatched, and unsupported items', async () => {
    const file = makeFile(
      [
        { position: 1, title: 'Imagine', artists: ['John Lennon'], durationMs: 183000, refs: {} },
        {
          position: 2,
          title: 'Completely Unknown Song XYZ',
          artists: ['Unknown Artist ZZZZ'],
          durationMs: 999999,
          refs: {},
        },
      ],
      [{ position: 3, kind: 'local', name: 'Local File' }]
    )

    const report = await engine.match(file, provider, provider.capabilities)

    assert.equal(report.summary.total, 3)
    assert.equal(report.summary.matched, 1)
    assert.equal(report.summary.unmatched, 1)
    assert.equal(report.summary.unsupported, 1)
    assert.ok(report.recommendations.length >= 2)
  })
})
