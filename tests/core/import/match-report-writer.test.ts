import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatchReportWriter } from '../../../src/core/import/match-report-writer.js'
import type { MatchReport } from '../../../src/core/matching/types.js'

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sple-report-writer-test-'))
}

function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Ignore errors during cleanup
  }
}

test('MatchReportWriter', async (t) => {
  const writer = new MatchReportWriter()

  // Mock report for testing
  const mockReport: MatchReport = {
    importedAt: '2026-10-05T12:00:00Z',
    sourceFile: {
      path: '/path/to/export.json',
      provider: 'spotify',
      playlistName: 'My Playlist',
      trackCount: 5,
    },
    targetProvider: 'youtube-music',
    results: [
      {
        track: { title: 'Song 1', artists: ['Artist 1'], album: 'Album', durationMs: 180000, refs: { src: 'src:1' } },
        position: 1,
        status: 'matched',
        confidence: 0.95,
        candidate: { ref: 'tgt:1', track: { title: 'Song 1', artists: [], refs: {} }, confidence: 0.95, strategy: 'metadata' },
        strategies: ['metadata'],
      },
      {
        track: { title: 'Song 2', artists: ['Artist 2'], album: 'Album', durationMs: 200000, refs: { src: 'src:2' } },
        position: 2,
        status: 'low-confidence',
        confidence: 0.55,
        candidate: { ref: 'tgt:2', track: { title: 'Song 2 Remix', artists: [], refs: {} }, confidence: 0.55, strategy: 'metadata' },
      },
      {
        track: { title: 'Song 3', artists: ['Artist 3'], album: 'Album', durationMs: 220000, refs: { src: 'src:3' } },
        position: 3,
        status: 'unmatched',
      },
      {
        track: {
          title: 'Episode Title',
          artists: [],
          album: '',
          durationMs: 3600000,
          refs: { src: 'src:4' },
        },
        position: 4,
        status: 'unsupported',
        error: 'Unsupported item type: episode',
      },
    ],
    summary: {
      total: 4,
      matched: 1,
      lowConfidence: 1,
      unmatched: 1,
      unsupported: 1,
    },
    recommendations: ['Review low-confidence matches before importing', 'Check unmatched tracks manually'],
  }

  await t.test('writeText', async (t) => {
    await t.test('should generate readable report', async () => {
      const text = await writer.writeText(mockReport)

      assert(text.includes('Match Report: My Playlist'))
      assert(text.includes('Source: spotify → Target: youtube-music'))
      assert(text.includes('Imported at: 2026-10-05T12:00:00Z'))
      assert(text.includes('Summary'))
      assert(text.includes('Total tracks:    4'))
      assert(text.includes('Matched:         1'))
      assert(text.includes('Low confidence:  1'))
      assert(text.includes('Unmatched:       1'))
      assert(text.includes('Unsupported:     1'))
    })

    await t.test('should include percentages in summary', async () => {
      const text = await writer.writeText(mockReport)

      // 25% for each (1/4 = 25%)
      assert(text.includes('25%'))
    })

    await t.test('should include recommendations', async () => {
      const text = await writer.writeText(mockReport)

      assert(text.includes('Recommendations'))
      assert(text.includes('Review low-confidence matches before importing'))
      assert(text.includes('Check unmatched tracks manually'))
    })

    await t.test('should list unmatched tracks', async () => {
      const text = await writer.writeText(mockReport)

      assert(text.includes('Unmatched Tracks'))
      assert(text.includes('Song 3'))
      assert(text.includes('Artist 3'))
    })

    await t.test('should list low-confidence matches', async () => {
      const text = await writer.writeText(mockReport)

      assert(text.includes('Low-Confidence Matches'))
      assert(text.includes('Song 2'))
      assert(text.includes('Song 2 Remix'))
    })

    await t.test('should handle empty report', async () => {
      const emptyReport: MatchReport = {
        importedAt: '2026-10-05T12:00:00Z',
        sourceFile: {
          path: '/path/to/export.json',
          provider: 'spotify',
          playlistName: 'Empty Playlist',
          trackCount: 0,
        },
        targetProvider: 'youtube-music',
        results: [],
        summary: {
          total: 0,
          matched: 0,
          lowConfidence: 0,
          unmatched: 0,
          unsupported: 0,
        },
      }

      const text = await writer.writeText(emptyReport)

      assert(text.includes('Empty Playlist'))
      assert(text.includes('Total tracks:    0'))
      assert(text.includes('0%'))
    })

    await t.test('should save text report to file', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'report.txt')

        await writer.writeText(mockReport, filePath)

        const content = readFileSync(filePath, 'utf-8')
        assert(content.includes('Match Report: My Playlist'))
        assert(content.includes('Summary'))
        assert(content.includes('Total tracks:    4'))
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should limit unmatched tracks to first 20', async () => {
      const report: MatchReport = {
        ...mockReport,
        results: Array.from({ length: 25 }, (_, i) => ({
          track: {
            title: `Unmatched Song ${i + 1}`,
            artists: [`Artist ${i + 1}`],
            album: 'Album',
            durationMs: 180000,
            refs: {},
          },
          position: i + 1,
          status: 'unmatched' as const,
        })),
        summary: {
          total: 25,
          matched: 0,
          lowConfidence: 0,
          unmatched: 25,
          unsupported: 0,
        },
      }

      const text = await writer.writeText(report)

      assert(text.includes('Unmatched Tracks'))
      assert(text.includes('Unmatched Song 1'))
      assert(text.includes('Unmatched Song 20'))
      assert(text.includes('... and 5 more'))
      assert(!text.includes('Unmatched Song 21'))
    })

    await t.test('should limit low-confidence matches to first 10', async () => {
      const report: MatchReport = {
        ...mockReport,
        results: Array.from({ length: 15 }, (_, i) => ({
          track: {
            title: `Low Conf Song ${i + 1}`,
            artists: [`Artist ${i + 1}`],
            album: 'Album',
            durationMs: 180000,
            refs: {},
          },
          position: i + 1,
          status: 'low-confidence' as const,
          confidence: 0.5,
          candidate: {
            ref: `tgt:${i + 1}`,
            track: { title: `Match ${i + 1}`, artists: [], refs: {} },
            confidence: 0.5,
            strategy: 'metadata' as const,
          },
        })),
        summary: {
          total: 15,
          matched: 0,
          lowConfidence: 15,
          unmatched: 0,
          unsupported: 0,
        },
      }

      const text = await writer.writeText(report)

      assert(text.includes('Low-Confidence Matches'))
      assert(text.includes('Low Conf Song 1'))
      assert(text.includes('Low Conf Song 10'))
      assert(text.includes('... and 5 more'))
      assert(!text.includes('Low Conf Song 11'))
    })
  })

  await t.test('writeJson', async (t) => {
    await t.test('should write report as formatted JSON', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'report.json')

        await writer.writeJson(mockReport, filePath)

        const content = readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(content)

        assert.equal(parsed.summary.matched, 1)
        assert.equal(parsed.summary.lowConfidence, 1)
        assert.equal(parsed.summary.unmatched, 1)
        assert.equal(parsed.summary.unsupported, 1)
        assert.equal(parsed.results.length, 4)
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should use 2-space indentation', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'report.json')

        await writer.writeJson(mockReport, filePath)

        const content = readFileSync(filePath, 'utf-8')

        // Check for 2-space indentation (lines starting with 2 spaces)
        const hasProperIndent = /\n  [a-zA-Z"]/m.test(content)
        assert(hasProperIndent, 'JSON should use 2-space indentation')
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should preserve report data when round-tripped', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'report.json')

        await writer.writeJson(mockReport, filePath)

        const content = readFileSync(filePath, 'utf-8')
        const parsed: MatchReport = JSON.parse(content)

        assert.deepEqual(parsed.importedAt, mockReport.importedAt)
        assert.deepEqual(parsed.sourceFile, mockReport.sourceFile)
        assert.equal(parsed.targetProvider, mockReport.targetProvider)
        assert.deepEqual(parsed.summary, mockReport.summary)
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should handle empty report', async () => {
      const tmpDir = createTempDir()
      try {
        const emptyReport: MatchReport = {
          importedAt: '2026-10-05T12:00:00Z',
          sourceFile: {
            path: '/path/to/export.json',
            provider: 'spotify',
            playlistName: 'Empty',
            trackCount: 0,
          },
          targetProvider: 'youtube-music',
          results: [],
          summary: {
            total: 0,
            matched: 0,
            lowConfidence: 0,
            unmatched: 0,
            unsupported: 0,
          },
        }

        const filePath = join(tmpDir, 'empty.json')
        await writer.writeJson(emptyReport, filePath)

        const content = readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(content)

        assert.equal(parsed.results.length, 0)
        assert.equal(parsed.summary.total, 0)
      } finally {
        cleanupTempDir(tmpDir)
      }
    })
  })

  await t.test('text return value', async (t) => {
    await t.test('should return text without writing when no path provided', async () => {
      const text = await writer.writeText(mockReport)

      assert(typeof text === 'string')
      assert(text.length > 0)
      assert(text.includes('Match Report'))
    })

    await t.test('should return same text when path is provided', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'report.txt')
        const returnedText = await writer.writeText(mockReport, filePath)

        const fileContent = readFileSync(filePath, 'utf-8')

        assert.equal(returnedText, fileContent)
      } finally {
        cleanupTempDir(tmpDir)
      }
    })
  })

  await t.test('percentage formatting', async (t) => {
    await t.test('should handle zero total', async () => {
      const emptyReport: MatchReport = {
        importedAt: '2026-10-05T12:00:00Z',
        sourceFile: {
          path: '/path/to/export.json',
          provider: 'spotify',
          playlistName: 'Empty',
          trackCount: 0,
        },
        targetProvider: 'youtube-music',
        results: [],
        summary: {
          total: 0,
          matched: 0,
          lowConfidence: 0,
          unmatched: 0,
          unsupported: 0,
        },
      }

      const text = await writer.writeText(emptyReport)

      assert(text.includes('0%'))
    })

    await t.test('should calculate percentages correctly', async () => {
      const report: MatchReport = {
        importedAt: '2026-10-05T12:00:00Z',
        sourceFile: {
          path: '/path/to/export.json',
          provider: 'spotify',
          playlistName: 'Test',
          trackCount: 100,
        },
        targetProvider: 'youtube-music',
        results: [],
        summary: {
          total: 100,
          matched: 50,
          lowConfidence: 25,
          unmatched: 20,
          unsupported: 5,
        },
      }

      const text = await writer.writeText(report)

      assert(text.includes('50%')) // matched
      assert(text.includes('25%')) // lowConfidence
      assert(text.includes('20%')) // unmatched
      assert(text.includes('5%')) // unsupported
    })

    await t.test('should round percentages', async () => {
      const report: MatchReport = {
        importedAt: '2026-10-05T12:00:00Z',
        sourceFile: {
          path: '/path/to/export.json',
          provider: 'spotify',
          playlistName: 'Test',
          trackCount: 3,
        },
        targetProvider: 'youtube-music',
        results: [],
        summary: {
          total: 3,
          matched: 1, // 33.33... should round to 33%
          lowConfidence: 1, // 33.33... should round to 33%
          unmatched: 1, // 33.33... should round to 33%
          unsupported: 0,
        },
      }

      const text = await writer.writeText(report)

      // Should use rounded percentages
      assert(text.includes('33%'))
    })
  })
})
