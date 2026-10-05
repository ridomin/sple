import { test } from 'node:test'
import * as assert from 'node:assert'
import type { MatchResult, MatchReport } from '../../../src/core/matching/types.js'

test('MatchResult with matched status', () => {
  const result: MatchResult = {
    track: {
      title: 'Song',
      artists: ['Artist'],
      album: 'Album',
      durationMs: 180000,
      refs: { 'spotify': 'src:1' },
    },
    position: 1,
    status: 'matched',
    confidence: 0.95,
    candidate: {
      trackRef: 'tgt:1',
      confidence: 0.95,
      metadata: { title: 'Song', artists: ['Artist'], duration: 180000 },
    },
    strategies: ['metadata'],
  }
  assert.strictEqual(result.status, 'matched')
  assert.strictEqual(result.confidence, 0.95)
})

test('MatchReport with summary', () => {
  const report: MatchReport = {
    importedAt: new Date().toISOString(),
    sourceFile: {
      path: '/path/to/export.json',
      provider: 'spotify',
      playlistName: 'My Playlist',
      trackCount: 100,
    },
    targetProvider: 'youtube-music',
    results: [],
    summary: {
      total: 100,
      matched: 95,
      lowConfidence: 3,
      unmatched: 2,
      unsupported: 0,
    },
  }
  assert.strictEqual(report.summary.matched + report.summary.lowConfidence, 98)
})

test('MatchResult should not have unsupported status by default', () => {
  const result: MatchResult = {
    track: {
      title: 'Song',
      artists: [],
      refs: { 'spotify': 'src:1' },
    },
    position: 1,
    status: 'unmatched',
  }
  assert.notStrictEqual(result.status, 'unsupported')
})
