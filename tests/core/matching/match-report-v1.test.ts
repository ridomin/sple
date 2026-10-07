import { test } from 'node:test'
import * as assert from 'node:assert'
import { MatchingEngine } from '../../../src/core/matching/matching-engine.js'
import type { CanonicalPlaylistFile } from '../../../src/core/export/format.js'
import { FakeProvider } from '../../../src/providers/fake/index.js'

// ADR-0009 Amendment 1 §6: match report v1.

function makeFile(): CanonicalPlaylistFile {
  return {
    schemaVersion: 1,
    exportedAt: '2026-10-07T00:00:00Z',
    generator: { name: 'sple', version: '0.1.0' },
    source: { provider: 'spotify', kind: 'playlist' },
    playlist: { name: 'Road Trip', trackCount: 3 },
    tracks: [
      // Out of position order on purpose
      { position: 2, title: 'Imagine', artists: ['John Lennon'], durationMs: 183000, isrc: 'USRC1', refs: { spotify: 'spotify:track:a' } },
      { position: 1, title: 'Known', artists: ['A'], refs: { fake: 'fake:track:k' } },
    ],
    unsupportedItems: [{ position: 3, kind: 'local', name: 'My Demo' }],
  } as CanonicalPlaylistFile
}

function makeProvider(): FakeProvider {
  const provider = new FakeProvider({ initialTracks: [{ id: 'img', title: 'Imagine', artists: ['John Lennon'], duration: 183000 }] })
  ;(provider.capabilities as any).isrcSearchMode = 'lookup'
  return provider
}

test('the report carries schemaVersion 1, minConfidence and targetPlaylistName', async () => {
  const provider = makeProvider()
  const report = await new MatchingEngine().match(makeFile(), provider, provider.capabilities, { minConfidence: 0.7 })
  assert.strictEqual(report.schemaVersion, 1)
  assert.strictEqual(report.minConfidence, 0.7)
  assert.strictEqual(report.targetPlaylistName, 'Road Trip', 'defaults to the file playlist name')
  assert.deepStrictEqual(report.recommendations, ['1 item(s) are not supported on the target provider and will be skipped.'])

  const named = await new MatchingEngine().match(makeFile(), provider, provider.capabilities, { targetPlaylistName: 'Mine' })
  assert.strictEqual(named.targetPlaylistName, 'Mine')
  assert.strictEqual(named.minConfidence, 0.5, 'default minConfidence')
  assert.deepStrictEqual(named.recommendations.length, 1)
})

test('results are in position order, then unsupported items', async () => {
  const provider = makeProvider()
  const report = await new MatchingEngine().match(makeFile(), provider, provider.capabilities)
  assert.deepStrictEqual(report.results.map((r) => [r.position, r.status]), [
    [1, 'matched'],
    [2, 'matched'],
    [3, 'unsupported'],
  ])
  assert.deepStrictEqual(report.results[2].strategies, [])
})

test('strategies lists every strategy tried, in order, ending with the winner', async () => {
  const provider = makeProvider()
  const report = await new MatchingEngine().match(makeFile(), provider, provider.capabilities)
  const known = report.results.find((r) => r.position === 1)!
  const imagine = report.results.find((r) => r.position === 2)!
  assert.deepStrictEqual(known.strategies, ['known-ref'])
  assert.deepStrictEqual(imagine.strategies, ['known-ref', 'isrc', 'metadata'])
  assert.strictEqual(imagine.candidate?.strategy, 'metadata')
  assert.strictEqual(imagine.confidence, imagine.candidate?.confidence)
})
