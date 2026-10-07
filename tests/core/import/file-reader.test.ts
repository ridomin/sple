import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanonicalFileReader, CSV_SOURCE_UNKNOWN_WARNING } from '../../../src/core/import/file-reader.js'
import { parseSpotifyTrackRef } from '../../../src/providers/spotify/playlist-ref.js'
import { parseYouTubeTrackRef } from '../../../src/providers/youtube-music/playlist-ref.js'
import { parseFakeTrackRef } from '../../../src/providers/fake/index.js'

// ADR-0008 Amendment 1, "Reading (import)".

const PARSERS = { spotify: parseSpotifyTrackRef, 'youtube-music': parseYouTubeTrackRef, fake: parseFakeTrackRef }
const SPOTIFY_ID = '4uLU6hMCjMI75M1A2tKUQC'
const HEADER = 'position,title,artists,album,duration_ms,added_at,isrc,ref'

const validJson = () => ({
  schemaVersion: 1,
  exportedAt: '2026-10-05T12:00:00Z',
  generator: { name: 'sple', version: '0.1.0' },
  source: { provider: 'spotify', kind: 'playlist' },
  playlist: { id: 'pl1', name: 'My Playlist', trackCount: 2 },
  tracks: [
    { position: 2, title: 'B', artists: ['X'], refs: { spotify: `spotify:track:${SPOTIFY_ID}` } },
    { position: 1, title: 'A', artists: ['X'], refs: { spotify: `spotify:track:${SPOTIFY_ID}` } },
  ],
  unsupportedItems: [],
})

async function read(name: string, content: string | object) {
  const dir = mkdtempSync(join(tmpdir(), 'sple-reader-'))
  const path = join(dir, name)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  const warnings: string[] = []
  try {
    const file = await new CanonicalFileReader({ trackRefParsers: PARSERS, onWarning: (w) => warnings.push(w) }).readFile(path)
    return { file, warnings }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('format is chosen by extension, case-insensitive; others are rejected', async () => {
  assert.equal((await read('a.JSON', validJson())).file.playlist.name, 'My Playlist')
  assert.equal((await read('a.Csv', `${HEADER}\n1,T,A,,,,,\n`)).file.tracks.length, 1)
  await assert.rejects(() => read('a.txt', `${HEADER}\n`), /Unsupported file type '\.txt'; use \.json or \.csv/)
  await assert.rejects(() => read('noext', '{}'), /Unsupported file type/)
})

test('JSON: tracks are returned in position order', async () => {
  const { file } = await read('p.json', validJson())
  assert.deepEqual(file.tracks.map((t) => t.title), ['A', 'B'])
})

test('JSON: an unsupported schema version has its own message', async () => {
  await assert.rejects(
    () => read('p.json', { ...validJson(), schemaVersion: 2 }),
    /Unsupported schema version: 2\. This version of sple supports v1 only\./
  )
})

test('JSON: every v1 invariant is checked and all problems are listed', async () => {
  const bad = validJson()
  bad.tracks[0].artists = []
  bad.playlist.trackCount = 7
  await assert.rejects(() => read('p.json', bad), (e: Error) => {
    assert.match(e.message, /^Invalid canonical playlist file: /)
    assert.match(e.message, /tracks\[0\]\.artists must be a non-empty array/)
    assert.match(e.message, /playlist\.trackCount must equal/)
    return true
  })
})

test('JSON: invalid JSON is rejected', async () => {
  await assert.rejects(() => read('p.json', '{not json'), /JSON/)
})

test('CSV: RFC 4180 quoting, including commas, quotes and line breaks', async () => {
  const csv = `${HEADER}\r\n1,"Hello, ""World""\nPart 2","A; B",,,,,\r\n`
  const { file } = await read('q.csv', csv)
  assert.equal(file.tracks.length, 1)
  assert.equal(file.tracks[0].title, 'Hello, "World"\nPart 2')
  assert.deepEqual(file.tracks[0].artists, ['A', 'B'])
})

test('CSV: columns in any order, extra columns ignored; missing columns rejected', async () => {
  const { file } = await read('o.csv', `ref,extra,isrc,added_at,duration_ms,album,artists,title,position\n,zzz,USRC1,,180000,Alb,Art,Song,3\n`)
  assert.equal(file.tracks[0].title, 'Song')
  assert.equal(file.tracks[0].position, 3)
  assert.equal(file.tracks[0].durationMs, 180000)
  assert.equal(file.tracks[0].isrc, 'USRC1')
  await assert.rejects(() => read('m.csv', 'position,title\n1,x\n'), /CSV header must contain/)
})

test('CSV: row rules for position, artists, empty and invalid fields, empty rows', async () => {
  const csv = [
    HEADER,
    ',First,,,abc,,,',
    '',
    ',,,,,,,',
    '0,Second, ; ,Album,180000,2026-01-01T00:00:00Z,,',
  ].join('\n')
  const { file } = await read('r.csv', csv)
  assert.equal(file.tracks.length, 2)
  const [first, second] = file.tracks
  assert.equal(first.position, 1, 'empty position → 1-based row number')
  assert.deepEqual(first.artists, ['Unknown Artist'])
  assert.equal(first.durationMs, undefined, 'non-integer duration → absent')
  assert.equal(first.album, undefined)
  assert.equal(first.addedAt, undefined)
  assert.equal(first.isrc, undefined)
  assert.equal(second.position, 4, 'position 0 is invalid → 1-based row number')
  assert.deepEqual(second.artists, ['Unknown Artist'])
  assert.equal(second.album, 'Album')
  assert.equal(second.addedAt, '2026-01-01T00:00:00Z')
})

test('CSV: defaults (kind, name from the file name, generator, exportedAt)', async () => {
  const { file } = await read('Road Trip.csv', `${HEADER}\n1,T,A,,,,,\n`)
  assert.equal(file.source.kind, 'playlist')
  assert.equal(file.playlist.name, 'Road Trip')
  assert.deepEqual(file.generator, { name: 'sple', version: 'unknown' })
  assert.match(file.exportedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/)
  assert.equal(file.playlist.trackCount, 1)
})

test('CSV: the source provider is inferred from refs and refs are stored canonically', async () => {
  const csv = `${HEADER}\n1,T,A,,,,,https://open.spotify.com/track/${SPOTIFY_ID}\n2,U,A,,,,,\n3,V,A,,,,,spotify:track:${SPOTIFY_ID}\n`
  const { file, warnings } = await read('s.csv', csv)
  assert.equal(file.source.provider, 'spotify')
  assert.deepEqual(file.tracks[0].refs, { spotify: `spotify:track:${SPOTIFY_ID}` })
  assert.deepEqual(file.tracks[1].refs, {})
  assert.deepEqual(warnings, [])

  const yt = await read('y.csv', `${HEADER}\n1,T,A,,,,,https://youtu.be/dQw4w9WgXcQ\n`)
  assert.equal(yt.file.source.provider, 'youtube-music')
  assert.deepEqual(yt.file.tracks[0].refs, { 'youtube-music': 'dQw4w9WgXcQ' })
})

test('CSV: mixed or unknown refs → source "unknown", refs dropped, one warning', async () => {
  const csv = `${HEADER}\n1,T,A,,,,,spotify:track:${SPOTIFY_ID}\n2,U,A,,,,,https://youtu.be/dQw4w9WgXcQ\n`
  const { file, warnings } = await read('mixed.csv', csv)
  assert.equal(file.source.provider, 'unknown')
  assert.deepEqual(file.tracks.map((t) => t.refs), [{}, {}])
  assert.deepEqual(warnings, [CSV_SOURCE_UNKNOWN_WARNING])
  assert.equal(CSV_SOURCE_UNKNOWN_WARNING, 'sple: warning: could not tell which provider the CSV refs belong to; matching by metadata only')

  const none = await read('n.csv', `${HEADER}\n1,T,A,,,,,something-else\n`)
  assert.equal(none.file.source.provider, 'unknown')
})
