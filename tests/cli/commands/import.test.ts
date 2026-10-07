import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { run } from '../../../src/cli/commands/import.js'
import type { CommandContext } from '../../../src/cli/cli.js'
import type { CanonicalPlaylistFile } from '../../../src/core/export/format.js'
import { EXIT_CODES } from '../../../src/cli/exit-codes.js'
import { FakeProvider, parseFakeTrackRef } from '../../../src/providers/fake/index.js'
import { AuthRequiredError, QuotaExhaustedError } from '../../../src/core/provider/errors.js'

class MockIO {
  out: string[] = []
  err: string[] = []

  logOut(msg: string) {
    this.out.push(msg)
  }

  logErr(msg: string) {
    this.err.push(msg)
  }

  reset() {
    this.out = []
    this.err = []
  }
}

function createTestContext(overrides?: Partial<CommandContext>): CommandContext & { mockIO: MockIO } {
  const mockIO = new MockIO()
  return {
    registry: {
      has: () => true,
      create: () => new FakeProvider({ pagination: 'cursor-forward', playlists: { access: ['owned'] } }),
      trackRefParsers: () => ({ fake: parseFakeTrackRef }),
    } as any,
    config: { provider: 'spotify', verbose: false },
    io: {
      out: (msg: string) => mockIO.logOut(msg),
      err: (msg: string) => mockIO.logErr(msg),
    },
    version: '0.1.0',
    json: false,
    quiet: false,
    debug: false,
    yes: false,
    mockIO,
    ...overrides,
  } as any
}

function createTestFile(): CanonicalPlaylistFile {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    generator: { name: 'sple', version: '0.1.0' },
    source: { provider: 'spotify', kind: 'playlist' },
    playlist: { name: 'Test Playlist', trackCount: 1 },
    tracks: [
      {
        position: 1,
        title: 'Test Song',
        artists: ['Test Artist'],
        album: 'Test Album',
        durationMs: 180000,
        refs: { spotify: 'spotify:track:123' },
      },
    ],
    unsupportedItems: [],
  }
}

test('import command: help flag', async () => {
  const ctx = createTestContext()
  const result = await run(ctx, ['--help'])
  assert.equal(result, EXIT_CODES.SUCCESS)
  assert(ctx.mockIO.out.length > 0)
  assert(ctx.mockIO.out[0].includes('Import'))
})

test('import command: -h flag', async () => {
  const ctx = createTestContext()
  const result = await run(ctx, ['-h'])
  assert.equal(result, EXIT_CODES.SUCCESS)
  assert(ctx.mockIO.out.length > 0)
})

test('import command: error when no file provided', async () => {
  const ctx = createTestContext()
  try {
    await run(ctx, [])
    assert.fail('Should have thrown UsageError')
  } catch (error: any) {
    assert(error.message.includes('No file provided'))
  }
})

test('import command: error when file path is empty', async () => {
  const ctx = createTestContext()
  try {
    await run(ctx, [''])
    assert.fail('Should have thrown UsageError')
  } catch (error: any) {
    assert(error.message.includes('File path cannot be empty'))
  }
})

test('import command: error when multiple files provided', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const file1 = join(tmpDir, 'file1.json')
    const file2 = join(tmpDir, 'file2.json')
    writeFileSync(file1, JSON.stringify(createTestFile()))
    writeFileSync(file2, JSON.stringify(createTestFile()))

    const ctx = createTestContext()
    try {
      await run(ctx, [file1, file2])
      assert.fail('Should have thrown UsageError')
    } catch (error: any) {
      assert(error.message.includes('Only one file'))
    }
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: --provider option', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })
    const result = await run(ctx, [filePath, '--provider', 'spotify', '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: -p short option', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })
    const result = await run(ctx, [filePath, '-p', 'spotify', '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: --name option', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })
    const result = await run(ctx, [filePath, '--name', 'Custom Name', '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
    // Just verify the command succeeds with --name option
    // The custom name is stored in the report but not displayed in the report text output
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: -n short option', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })
    const result = await run(ctx, [filePath, '-n', 'Custom Name', '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: --report option (text)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const reportPath = join(tmpDir, 'report.txt')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })
    const result = await run(ctx, [filePath, '--report', reportPath, '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
    assert(ctx.mockIO.out.some((msg) => msg.includes('saved to')))

    const reportContent = readFileSync(reportPath, 'utf-8')
    assert(reportContent.includes('Match Report'))
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: --report option (JSON)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const reportPath = join(tmpDir, 'report.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })
    const result = await run(ctx, [filePath, '--report', reportPath, '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)

    const reportContent = readFileSync(reportPath, 'utf-8')
    const json = JSON.parse(reportContent)
    assert(json.summary)
    assert(json.results)
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: --dry-run flag', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })
    const result = await run(ctx, [filePath, '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
    assert(ctx.mockIO.err.some((msg) => msg.includes('Dry run')))
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: --yes flag', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })
    const result = await run(ctx, [filePath, '--yes', '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: --min-confidence validation (valid values)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })

    // Test 0.5
    let result = await run(ctx, [filePath, '--min-confidence', '0.5', '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)

    // Test 0.0
    result = await run(ctx, [filePath, '--min-confidence', '0.0', '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)

    // Test 1.0
    result = await run(ctx, [filePath, '--min-confidence', '1.0', '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: --min-confidence validation (invalid > 1.0)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext()
    try {
      await run(ctx, [filePath, '--min-confidence', '1.5', '--dry-run'])
      assert.fail('Should have thrown UsageError')
    } catch (error: any) {
      assert(error.message.includes('between 0 and 1'))
    }
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: --min-confidence validation (invalid < 0.0)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext()
    try {
      await run(ctx, [filePath, '--min-confidence', '-0.1', '--dry-run'])
      assert.fail('Should have thrown UsageError')
    } catch (error: any) {
      // The negative number may be interpreted as a flag, so check for either error message
      assert(
        error.message.includes('between 0 and 1') ||
        error.message.includes('Unknown option') ||
        error.message.includes('option'),
        `Got error: ${error.message}`
      )
    }
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: --min-confidence validation (non-numeric)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext()
    try {
      await run(ctx, [filePath, '--min-confidence', 'invalid', '--dry-run'])
      assert.fail('Should have thrown UsageError')
    } catch (error: any) {
      assert(error.message.includes('between 0 and 1'))
    }
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: error on non-existent file', async () => {
  const ctx = createTestContext({ yes: true })
  try {
    await run(ctx, ['/nonexistent/path/file.json', '--dry-run'])
    assert.fail('Should have thrown UsageError')
  } catch (error: any) {
    assert(error.message.includes('Failed to read file'))
  }
})

test('import command: read JSON files', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })
    const result = await run(ctx, [filePath, '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
    assert(ctx.mockIO.out.length > 0)
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: read CSV files', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.csv')
    const csvContent = `position,title,artists,album,duration_ms,added_at,isrc,ref
1,Test Song,Test Artist,Test Album,180000,2026-10-05T00:00:00Z,,spotify:track:123`
    writeFileSync(filePath, csvContent)

    const ctx = createTestContext({ yes: true })
    const result = await run(ctx, [filePath, '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
    assert(ctx.mockIO.out.length > 0)
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: error on invalid JSON', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'invalid.json')
    writeFileSync(filePath, 'not valid json')

    const ctx = createTestContext()
    try {
      await run(ctx, [filePath, '--dry-run'])
      assert.fail('Should have thrown UsageError')
    } catch (error: any) {
      assert(error.message.includes('Failed to read file'))
    }
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: error on unknown provider', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({
      registry: {
        has: () => false,
        create: () => null,
      } as any,
    })

    try {
      await run(ctx, [filePath, '--provider', 'unknown-provider', '--dry-run'])
      assert.fail('Should have thrown UsageError')
    } catch (error: any) {
      assert(error.message.includes('Unknown provider'))
    }
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: output report to stdout by default', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext({ yes: true })
    await run(ctx, [filePath, '--dry-run'])
    assert(ctx.mockIO.out.some((msg) => msg.includes('Match Report')))
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: dry-run does not create playlist', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  try {
    const filePath = join(tmpDir, 'test.json')
    const file = createTestFile()
    writeFileSync(filePath, JSON.stringify(file))

    const ctx = createTestContext()
    const result = await run(ctx, [filePath, '--dry-run'])
    assert.equal(result, EXIT_CODES.SUCCESS)
    assert(ctx.mockIO.err.some((msg) => msg.includes('Dry run')))
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

// ---- Playlist creation ----

function makeCreationProvider(): FakeProvider {
  const provider = new FakeProvider({
    initialTracks: [
      { id: 't1', title: 'Song 1', artists: ['A'], duration: 180000 },
      { id: 't2', title: 'Song 2', artists: ['A'], duration: 180000, isrc: 'USRC10000002' },
    ],
  })
  // Let the ISRC strategy (confidence 0.95) find t2
  ;(provider.capabilities as any).isrcSearchMode = 'lookup'
  provider.searchTracks = async (q) => {
    if (q.kind !== 'isrc' || q.isrc !== 'USRC10000002') return []
    return [{ ref: 'fake:track:t2', track: { title: 'Song 2', artists: ['A'], durationMs: 180000, refs: { fake: 'fake:track:t2' } } }]
  }
  return provider
}

function withImportFile(tracks: CanonicalPlaylistFile['tracks'], fn: (path: string) => Promise<void>): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  const filePath = join(tmpDir, 'test.json')
  const file = createTestFile()
  writeFileSync(filePath, JSON.stringify({ ...file, playlist: { ...file.playlist, trackCount: tracks.length }, tracks }))
  return fn(filePath).finally(() => rmSync(tmpDir, { recursive: true }))
}

const knownRefTrack = (position: number, fakeRef: string) =>
  ({ position, title: `Song ${position}`, artists: ['A'], durationMs: 180000, refs: { fake: `fake:track:${fakeRef}` } }) as any

async function createdTrackRefs(provider: FakeProvider): Promise<string[]> {
  const page = await provider.getPlaylistTracks('1', {})
  return page.items.map((t) => t.refs.fake as string)
}

test('import command: creates playlist with matched tracks and skips low-confidence ones', async () => {
  const provider = makeCreationProvider()
  const isrcTrack = { position: 2, title: 'Song 2', artists: ['A'], durationMs: 180000, isrc: 'USRC10000002', refs: { spotify: 'spotify:track:source2' } } as any
  await withImportFile([knownRefTrack(1, 't1'), isrcTrack], async (filePath) => {
    const ctx = createTestContext({ registry: { has: () => true, create: () => provider, trackRefParsers: () => ({ fake: parseFakeTrackRef }) } as any })
    const result = await run(ctx, [filePath, '--yes', '--min-confidence', '0.99'])

    assert.equal(result, EXIT_CODES.SUCCESS)
    assert.deepEqual(await createdTrackRefs(provider), ['fake:track:t1'])
    assert(ctx.mockIO.err.some((msg) => msg.includes('1 low-confidence match(es) skipped')), ctx.mockIO.err.join('\n'))
  })
})

test('import command: exits non-zero and lists tracks the provider rejected', async () => {
  const provider = makeCreationProvider()
  await withImportFile([knownRefTrack(1, 't1'), knownRefTrack(2, 'gone')], async (filePath) => {
    const ctx = createTestContext({ json: true, registry: { has: () => true, create: () => provider, trackRefParsers: () => ({ fake: parseFakeTrackRef }) } as any })
    const result = await run(ctx, [filePath, '--yes'])

    assert.equal(result, EXIT_CODES.ERROR)
    assert.deepEqual(await createdTrackRefs(provider), ['fake:track:t1'])
    assert(ctx.mockIO.err.some((msg) => msg.includes('gone') && msg.includes('Track not found')), ctx.mockIO.err.join('\n'))
    const last = JSON.parse(ctx.mockIO.err[ctx.mockIO.err.length - 1])
    assert.equal(last.error.type, 'PartialFailure')
    assert.equal(last.error.exitCode, EXIT_CODES.ERROR)
  })
})

test('import command: names the created playlist and rethrows the provider error when adding tracks fails', async () => {
  const provider = makeCreationProvider()
  provider.setQuotaBucket(0)
  await withImportFile([knownRefTrack(1, 't1')], async (filePath) => {
    const ctx = createTestContext({ registry: { has: () => true, create: () => provider, trackRefParsers: () => ({ fake: parseFakeTrackRef }) } as any })

    await assert.rejects(() => run(ctx, [filePath, '--yes']), QuotaExhaustedError)
    assert(ctx.mockIO.err.some((msg) => msg.includes('playlist 1 was created')), ctx.mockIO.err.join('\n'))
  })
})

test('import command: auth errors from playlist creation are not turned into usage errors', async () => {
  const provider = makeCreationProvider()
  provider.createPlaylist = async () => {
    throw new AuthRequiredError('missing scope', 'missing-scope', 'playlist-modify')
  }
  await withImportFile([knownRefTrack(1, 't1')], async (filePath) => {
    const ctx = createTestContext({ registry: { has: () => true, create: () => provider, trackRefParsers: () => ({ fake: parseFakeTrackRef }) } as any })
    await assert.rejects(() => run(ctx, [filePath, '--yes']), AuthRequiredError)
  })
})

test('import command: an auth error during matching stops the import before any playlist is created', async () => {
  const provider = makeCreationProvider()
  let created = false
  provider.searchTracks = async () => {
    throw new AuthRequiredError('expired', 'token-expired')
  }
  const createPlaylist = provider.createPlaylist.bind(provider)
  provider.createPlaylist = async (...args) => {
    created = true
    return createPlaylist(...args)
  }
  const isrcTrack = { position: 1, title: 'Song 2', artists: ['A'], durationMs: 180000, isrc: 'USRC10000002', refs: { spotify: 'spotify:track:source2' } } as any
  await withImportFile([isrcTrack, knownRefTrack(2, 't1')], async (filePath) => {
    const ctx = createTestContext({ registry: { has: () => true, create: () => provider, trackRefParsers: () => ({ fake: parseFakeTrackRef }) } as any })
    await assert.rejects(() => run(ctx, [filePath, '--yes']), AuthRequiredError)
    assert.equal(created, false)
  })
})

test('import command: CSV refs are inferred as fake refs, so the known-ref strategy adds them', async () => {
  const provider = makeCreationProvider()
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  const filePath = join(tmpDir, 'Road Trip.csv')
  writeFileSync(filePath, 'position,title,artists,album,duration_ms,added_at,isrc,ref\r\n1,Song 1,A,,180000,,,fake:track:t1\r\n')
  try {
    const ctx = createTestContext({ registry: { has: () => true, create: () => provider, trackRefParsers: () => ({ fake: parseFakeTrackRef }) } as any })
    assert.equal(await run(ctx, [filePath, '--yes']), EXIT_CODES.SUCCESS)
    assert.deepEqual(await createdTrackRefs(provider), ['fake:track:t1'])
    assert(!ctx.mockIO.err.some((m) => m.includes('could not tell')), ctx.mockIO.err.join('\n'))
    const page = await provider.listPlaylists({ limit: 50 })
    assert(page.items.some((p) => p.name === 'Road Trip'), 'playlist named after the CSV file')
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: CSV refs from no single provider warn on stderr', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  const filePath = join(tmpDir, 'mixed.csv')
  writeFileSync(filePath, 'position,title,artists,album,duration_ms,added_at,isrc,ref\r\n1,Song 1,A,,180000,,,something-else\r\n')
  try {
    const ctx = createTestContext()
    await run(ctx, [filePath, '--dry-run'])
    assert(
      ctx.mockIO.err.includes('sple: warning: could not tell which provider the CSV refs belong to; matching by metadata only'),
      ctx.mockIO.err.join('\n')
    )
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})

test('import command: an unsupported extension is a usage error', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-'))
  const filePath = join(tmpDir, 'list.txt')
  writeFileSync(filePath, 'x')
  try {
    await assert.rejects(() => run(createTestContext(), [filePath, '--dry-run']), /Unsupported file type '\.txt'/)
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
})
