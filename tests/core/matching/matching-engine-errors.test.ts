import { test, describe } from 'node:test'
import * as assert from 'node:assert'
import { MatchingEngine } from '../../../src/core/matching/matching-engine.js'
import type { CanonicalPlaylistFile } from '../../../src/core/export/format.js'
import { FakeProvider } from '../../../src/providers/fake/index.js'
import {
  AuthRequiredError,
  QuotaExhaustedError,
  RateLimitError,
  ProviderError,
} from '../../../src/core/provider/errors.js'

// ADR-0009 Amendment 1 §1.4: auth, quota and rate-limit errors stop matching;
// other strategy errors are recorded and the next strategy runs.

function makeFile(): CanonicalPlaylistFile {
  return {
    schemaVersion: 1,
    exportedAt: '2026-10-07T00:00:00Z',
    generator: { name: 'sple', version: '0.1.0' },
    source: { provider: 'spotify', kind: 'playlist' },
    playlist: { name: 'P', trackCount: 2 },
    tracks: [
      { position: 1, title: 'Song 1', artists: ['A'], durationMs: 180000, isrc: 'USRC10000001', refs: {} },
      { position: 2, title: 'Song 2', artists: ['A'], durationMs: 180000, refs: {} },
    ],
    unsupportedItems: [],
  } as CanonicalPlaylistFile
}

function makeProvider(searchTracks: FakeProvider['searchTracks']): FakeProvider {
  const provider = new FakeProvider()
  ;(provider.capabilities as any).isrcSearchMode = 'lookup'
  provider.searchTracks = searchTracks
  return provider
}

const hit = (title: string) => [{ ref: 'x', track: { title, artists: ['A'], durationMs: 180000, refs: { fake: 'x' } } }]

describe('MatchingEngine errors', () => {
  const fatal: [string, () => Error, new (...args: any[]) => Error][] = [
    ['AuthRequiredError', () => new AuthRequiredError('expired', 'token-expired'), AuthRequiredError],
    ['QuotaExhaustedError', () => new QuotaExhaustedError('quota', 'search'), QuotaExhaustedError],
    ['RateLimitError', () => new RateLimitError('slow down'), RateLimitError],
  ]

  for (const [name, make, ErrorClass] of fatal) {
    test(`${name} stops matching and propagates`, async () => {
      let calls = 0
      const provider = makeProvider(async () => {
        calls++
        throw make()
      })
      await assert.rejects(
        () => new MatchingEngine().match(makeFile(), provider, provider.capabilities),
        ErrorClass
      )
      assert.strictEqual(calls, 1, 'no further strategy or track is tried')
    })
  }

  test('a non-fatal strategy error falls through to the next strategy', async () => {
    const provider = makeProvider(async (q) => {
      if (q.kind === 'isrc') throw new ProviderError('HTTP 500')
      return hit(q.title)
    })
    const report = await new MatchingEngine().match(makeFile(), provider, provider.capabilities)
    assert.strictEqual(report.results[0].status, 'matched')
    assert.deepStrictEqual(report.results[0].strategies, ['metadata'])
  })

  test('when every strategy errors, the track is unmatched with the last error message', async () => {
    const provider = makeProvider(async (q) => {
      throw new ProviderError(q.kind === 'isrc' ? 'isrc boom' : 'metadata boom')
    })
    const report = await new MatchingEngine().match(makeFile(), provider, provider.capabilities)
    assert.strictEqual(report.results[0].status, 'unmatched')
    assert.strictEqual(report.results[0].error, 'metadata boom')
    assert.strictEqual(report.results[1].status, 'unmatched')
    assert.strictEqual(report.results[1].error, 'metadata boom')
  })
})
