import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanonicalFileReader } from '../../../src/core/import/file-reader.js'

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sple-reader-test-'))
}

function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Ignore errors during cleanup
  }
}

test('CanonicalFileReader', async (t) => {
  const reader = new CanonicalFileReader()

  await t.test('readFile (JSON)', async (t) => {
    await t.test('should read valid JSON export file', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-export.json')

        const content = {
          schemaVersion: 1,
          exportedAt: '2026-10-05T12:00:00Z',
          generator: { name: 'sple', version: '0.1.0' },
          source: { provider: 'spotify', kind: 'playlist' },
          playlist: {
            id: 'pl1',
            name: 'My Playlist',
            trackCount: 1,
          },
          tracks: [
            {
              position: 1,
              title: 'Song',
              artists: ['Artist'],
              album: 'Album',
              durationMs: 180000,
              refs: { spotify: 'spotify:track:123' },
            },
          ],
          unsupportedItems: [],
        }

        writeFileSync(filePath, JSON.stringify(content))

        const result = await reader.readFile(filePath)
        assert.equal(result.schemaVersion, 1)
        assert.equal(result.tracks.length, 1)
        assert.equal(result.tracks[0].title, 'Song')
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should reject unsupported schema version', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-export-v2.json')

        const content = {
          schemaVersion: 2,
          tracks: [],
        }

        writeFileSync(filePath, JSON.stringify(content))

        await assert.rejects(
          async () => reader.readFile(filePath),
          /Unsupported schema version: 2/
        )
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should reject missing tracks array', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-export-no-tracks.json')

        const content = {
          schemaVersion: 1,
          exportedAt: '2026-10-05T12:00:00Z',
        }

        writeFileSync(filePath, JSON.stringify(content))

        await assert.rejects(
          async () => reader.readFile(filePath),
          /Invalid file: missing or invalid tracks array/
        )
      } finally {
        cleanupTempDir(tmpDir)
      }
    })
  })

  await t.test('readFile (CSV)', async (t) => {
    await t.test('should read valid CSV export file', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-export.csv')

        const content = 'position,title,artists,album,duration_ms,added_at,isrc,ref\n1,Song,Artist,Album,180000,2026-10-05T00:00:00Z,,spotify:track:123\n'
        writeFileSync(filePath, content)

        const result = await reader.readFile(filePath)
        assert.equal(result.tracks.length, 1)
        assert.equal(result.tracks[0].title, 'Song')
        assert.deepEqual(result.tracks[0].artists, ['Artist'])
        assert.equal(result.tracks[0].album, 'Album')
        assert.equal(result.tracks[0].durationMs, 180000)
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should handle quoted CSV fields with special characters', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-quoted.csv')

        const content = 'position,title,artists,album,duration_ms,added_at,isrc,ref\n1,"Song, Pt. 1","Artist A; Artist B",Album,180000,,,spotify:track:123\n'
        writeFileSync(filePath, content)

        const result = await reader.readFile(filePath)
        assert.equal(result.tracks[0].title, 'Song, Pt. 1')
        assert.deepEqual(result.tracks[0].artists, ['Artist A', 'Artist B'])
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should handle escaped quotes in quoted fields', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-escaped-quotes.csv')

        const content = 'position,title,artists,album,duration_ms,added_at,isrc,ref\n1,"Song ""Special"" Edition",Artist,Album,180000,,,spotify:track:123\n'
        writeFileSync(filePath, content)

        const result = await reader.readFile(filePath)
        assert.equal(result.tracks[0].title, 'Song "Special" Edition')
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should handle multiple artists separated by semicolons', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-multi-artist.csv')

        const content = 'position,title,artists,album,duration_ms,added_at,isrc,ref\n1,Song,"Artist One; Artist Two; Artist Three",Album,180000,,,spotify:track:123\n'
        writeFileSync(filePath, content)

        const result = await reader.readFile(filePath)
        assert.deepEqual(result.tracks[0].artists, ['Artist One', 'Artist Two', 'Artist Three'])
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should handle empty cells in CSV', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-empty-cells.csv')

        const content = 'position,title,artists,album,duration_ms,added_at,isrc,ref\n1,Song,Artist,,,\n'
        writeFileSync(filePath, content)

        const result = await reader.readFile(filePath)
        assert.equal(result.tracks[0].album, '')
        assert.equal(result.tracks[0].durationMs, undefined)
        assert.equal(result.tracks[0].addedAt, undefined)
        assert.equal(result.tracks[0].isrc, undefined)
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should reject CSV with missing required columns', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-bad-header.csv')

        const content = 'position,title,album\n1,Song,Album\n'
        writeFileSync(filePath, content)

        await assert.rejects(
          async () => reader.readFile(filePath),
          /CSV header missing required columns/
        )
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should reject empty CSV file', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-empty.csv')
        writeFileSync(filePath, '')

        await assert.rejects(
          async () => reader.readFile(filePath),
          /CSV file is empty or has no header/
        )
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should handle CSV with multiple data rows', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-multiple-rows.csv')

        const content = 'position,title,artists,album,duration_ms,added_at,isrc,ref\n1,Song One,Artist A,Album,180000,,,spotify:track:1\n2,Song Two,Artist B,Album,200000,,,spotify:track:2\n3,Song Three,Artist C,Album,220000,,,spotify:track:3\n'
        writeFileSync(filePath, content)

        const result = await reader.readFile(filePath)
        assert.equal(result.tracks.length, 3)
        assert.equal(result.tracks[0].title, 'Song One')
        assert.equal(result.tracks[1].title, 'Song Two')
        assert.equal(result.tracks[2].title, 'Song Three')
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should handle CSV with blank lines', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test-blank-lines.csv')

        const content = 'position,title,artists,album,duration_ms,added_at,isrc,ref\n1,Song One,Artist A,Album,180000,,,spotify:track:1\n\n2,Song Two,Artist B,Album,200000,,,spotify:track:2\n'
        writeFileSync(filePath, content)

        const result = await reader.readFile(filePath)
        assert.equal(result.tracks.length, 2)
        assert.equal(result.tracks[0].title, 'Song One')
        assert.equal(result.tracks[1].title, 'Song Two')
      } finally {
        cleanupTempDir(tmpDir)
      }
    })
  })

  await t.test('extension detection', async (t) => {
    await t.test('should detect JSON by extension', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test.json')

        const content = {
          schemaVersion: 1,
          exportedAt: '2026-10-05T12:00:00Z',
          generator: { name: 'sple', version: '0.1.0' },
          source: { provider: 'spotify', kind: 'playlist' },
          playlist: { name: 'Test', trackCount: 0 },
          tracks: [],
          unsupportedItems: [],
        }

        writeFileSync(filePath, JSON.stringify(content))

        const result = await reader.readFile(filePath)
        assert.equal(result.schemaVersion, 1)
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should detect CSV by extension', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test.csv')

        const content = 'position,title,artists,album,duration_ms,added_at,isrc,ref\n1,Song,Artist,Album,180000,,,spotify:track:123\n'
        writeFileSync(filePath, content)

        const result = await reader.readFile(filePath)
        assert.equal(result.tracks.length, 1)
        assert.equal(result.tracks[0].title, 'Song')
      } finally {
        cleanupTempDir(tmpDir)
      }
    })

    await t.test('should handle uppercase .JSON extension', async () => {
      const tmpDir = createTempDir()
      try {
        const filePath = join(tmpDir, 'test.JSON')

        const content = {
          schemaVersion: 1,
          exportedAt: '2026-10-05T12:00:00Z',
          generator: { name: 'sple', version: '0.1.0' },
          source: { provider: 'spotify', kind: 'playlist' },
          playlist: { name: 'Test', trackCount: 0 },
          tracks: [],
          unsupportedItems: [],
        }

        writeFileSync(filePath, JSON.stringify(content))

        const result = await reader.readFile(filePath)
        assert.equal(result.schemaVersion, 1)
      } finally {
        cleanupTempDir(tmpDir)
      }
    })
  })
})
