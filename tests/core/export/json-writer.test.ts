import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeJSON } from '../../../src/core/export/json-writer.js'
import {
  createPlaylistFile,
  ExportFormatError,
  LIKED_SONGS_NAME,
  type CanonicalPlaylistFile,
} from '../../../src/core/export/format.js'
import { EXPORTED_AT, samplePlaylistFile, schema, schemaErrors, track } from './helpers.js'

/** Write, parse, and assert the output validates against the published schema. */
function writeAndValidate(file: CanonicalPlaylistFile): CanonicalPlaylistFile {
  const text = writeJSON(file)
  const parsed = JSON.parse(text) as CanonicalPlaylistFile
  assert.deepEqual(schemaErrors(parsed), [], 'output must validate against the v1 schema')
  return parsed
}

test('canonical playlist JSON schema', async (t) => {
  await t.test('is a JSON Schema 2020-12 document', () => {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  })

  await t.test('is included in the npm package', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
    })
    const [pack] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>
    assert.ok(pack.files.some((f) => f.path === 'schemas/canonical-playlist.v1.schema.json'))
  })

  await t.test('rejects a liked file whose name is not "Liked Songs"', () => {
    const file = samplePlaylistFile({ source: { provider: 'spotify', kind: 'liked' } })
    assert.notDeepEqual(schemaErrors(file), [])
  })

  await t.test('rejects unknown properties and empty artists', () => {
    const extra = { ...samplePlaylistFile(), extra: true }
    assert.notDeepEqual(schemaErrors(extra), [])
    const file = samplePlaylistFile()
    file.tracks[0] = { ...file.tracks[0]!, artists: [] }
    assert.notDeepEqual(schemaErrors(file), [])
  })

  await t.test('rejects a non-UTC exportedAt', () => {
    const file = samplePlaylistFile({ exportedAt: '2026-10-02T10:00:00+02:00' })
    assert.notDeepEqual(schemaErrors(file), [])
  })
})

test('writeJSON', async (t) => {
  await t.test('writes a schema-valid file with all v1 fields', () => {
    const parsed = writeAndValidate(samplePlaylistFile())
    assert.equal(parsed.schemaVersion, 1)
    assert.equal(parsed.exportedAt, '2026-10-02T10:00:00.000Z')
    assert.deepEqual(parsed.generator, { name: 'sple', version: '0.1.0' })
    assert.deepEqual(parsed.source, { provider: 'spotify', kind: 'playlist', userId: 'user1' })
    assert.equal(parsed.playlist.name, 'Road trip')
    assert.equal(parsed.playlist.trackCount, 4)
    assert.deepEqual(
      parsed.tracks.map((x) => x.position),
      [1, 2, 4]
    )
    assert.deepEqual(parsed.unsupportedItems, [
      { position: 3, kind: 'local', name: 'My demo.mp3', ref: 'spotify:local:::My+demo:0' },
    ])
  })

  await t.test('is lossless for track fields, including isrc null vs string', () => {
    const file = samplePlaylistFile()
    const parsed = writeAndValidate(file)
    assert.deepEqual(parsed.tracks, file.tracks)
    assert.equal(parsed.tracks[0]!.isrc, null)
    assert.equal(parsed.tracks[1]!.isrc, 'USRC17607839')
  })

  await t.test('omits absent optional fields', () => {
    const file = createPlaylistFile({
      generatorVersion: '0.1.0',
      exportedAt: EXPORTED_AT,
      source: { provider: 'fake', kind: 'playlist' },
      playlist: { name: 'Minimal' },
      tracks: [{ position: 1, title: 'T', artists: ['A'], refs: { fake: 'fake:track:1' } }],
    })
    const text = writeJSON(file)
    const parsed = writeAndValidate(file)
    assert.deepEqual(parsed.tracks[0], { position: 1, title: 'T', artists: ['A'], refs: { fake: 'fake:track:1' } })
    assert.deepEqual(parsed.playlist, { name: 'Minimal', trackCount: 1 })
    assert.ok(!text.includes('undefined'))
  })

  await t.test('writes an empty playlist', () => {
    const file = createPlaylistFile({
      generatorVersion: '0.1.0',
      exportedAt: EXPORTED_AT,
      source: { provider: 'spotify', kind: 'playlist' },
      playlist: { name: 'Empty', id: 'e1' },
      tracks: [],
    })
    const parsed = writeAndValidate(file)
    assert.equal(parsed.playlist.trackCount, 0)
    assert.deepEqual(parsed.tracks, [])
    assert.deepEqual(parsed.unsupportedItems, [])
  })

  await t.test('Liked Songs: source.kind "liked" and playlist.name "Liked Songs"', () => {
    const file = createPlaylistFile({
      generatorVersion: '0.1.0',
      exportedAt: EXPORTED_AT,
      source: { provider: 'spotify', kind: 'liked', userId: 'user1' },
      playlist: {},
      tracks: [track(1), track(2)],
    })
    const parsed = writeAndValidate(file)
    assert.equal(parsed.source.kind, 'liked')
    assert.equal(parsed.playlist.name, LIKED_SONGS_NAME)
    assert.equal(parsed.playlist.name, 'Liked Songs')
    assert.equal(parsed.playlist.trackCount, 2)
  })

  await t.test('createPlaylistFile forces the Liked Songs name for liked sources', () => {
    const file = createPlaylistFile({
      generatorVersion: '0.1.0',
      source: { provider: 'spotify', kind: 'liked' },
      playlist: { name: 'Something else' },
      tracks: [],
    })
    assert.equal(file.playlist.name, 'Liked Songs')
    assert.match(file.exportedAt, /Z$/)
    writeAndValidate(file)
  })

  await t.test('preserves non-ASCII and special characters', () => {
    const file = samplePlaylistFile()
    file.tracks[0] = track(1, { title: 'Ünïcödé "quoted", line\nbreak 🎵', artists: ['Björk', '坂本龍一'] })
    const parsed = writeAndValidate(file)
    assert.equal(parsed.tracks[0]!.title, 'Ünïcödé "quoted", line\nbreak 🎵')
    assert.deepEqual(parsed.tracks[0]!.artists, ['Björk', '坂本龍一'])
  })

  await t.test('sorts by position and drops unknown runtime properties', () => {
    const file = samplePlaylistFile()
    file.tracks = [file.tracks[2]!, file.tracks[0]!, file.tracks[1]!]
    ;(file.tracks[0] as unknown as Record<string, unknown>).internal = 'x'
    ;(file.playlist as unknown as Record<string, unknown>).owned = true
    const parsed = writeAndValidate(file)
    assert.deepEqual(
      parsed.tracks.map((x) => x.position),
      [1, 2, 4]
    )
    assert.ok(!('internal' in parsed.tracks[2]!))
    assert.ok(!('owned' in parsed.playlist))
  })

  await t.test('output is 2-space indented with a trailing newline', () => {
    const text = writeJSON(samplePlaylistFile())
    assert.ok(text.startsWith('{\n  "schemaVersion": 1,'))
    assert.ok(text.endsWith('}\n'))
  })

  await t.test('rejects duplicate positions', () => {
    const file = samplePlaylistFile()
    file.unsupportedItems = [{ position: 2, kind: 'episode' }]
    file.playlist.trackCount = 4
    assert.throws(() => writeJSON(file), (err: unknown) => {
      assert.ok(err instanceof ExportFormatError)
      assert.match(err.message, /position 2 is used more than once/)
      return true
    })
  })

  await t.test('rejects an inconsistent trackCount', () => {
    const file = samplePlaylistFile()
    file.playlist.trackCount = 99
    assert.throws(() => writeJSON(file), ExportFormatError)
  })

  await t.test('rejects a liked file with another name', () => {
    const file = samplePlaylistFile({ source: { provider: 'spotify', kind: 'liked' } })
    assert.throws(() => writeJSON(file), /Liked Songs/)
  })

  await t.test('rejects invalid track data', () => {
    const cases: Array<Partial<CanonicalPlaylistFile['tracks'][number]>> = [
      { artists: [] },
      { position: 0 },
      { durationMs: -1 },
      { durationMs: 1.5 },
      { refs: {} },
      { addedAt: 'yesterday' },
    ]
    for (const overrides of cases) {
      const file = samplePlaylistFile()
      file.tracks[0] = track(1, overrides)
      assert.throws(() => writeJSON(file), ExportFormatError, JSON.stringify(overrides))
      // The schema agrees with the writer on each case.
      assert.notDeepEqual(schemaErrors(file), [], JSON.stringify(overrides))
    }
  })

  await t.test('rejects a non-UTC exportedAt', () => {
    const file = samplePlaylistFile({ exportedAt: '2026-10-02T10:00:00+02:00' })
    assert.throws(() => writeJSON(file), /exportedAt/)
  })
})
