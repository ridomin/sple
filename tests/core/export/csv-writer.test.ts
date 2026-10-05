import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CSV_COLUMNS, csvCell, writeCSV } from '../../../src/core/export/csv-writer.js'
import { createPlaylistFile, ExportFormatError } from '../../../src/core/export/format.js'
import { EXPORTED_AT, samplePlaylistFile, track } from './helpers.js'

/**
 * Strict RFC 4180 parser used only to check round-trips. Records end with
 * CRLF; a bare CR or LF outside quotes is an error.
 */
function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  let quoted = false
  while (i < text.length) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        const next = text[i]
        if (next !== ',' && next !== '\r') throw new Error(`unexpected ${JSON.stringify(next)} after closing quote`)
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"') {
      if (cell !== '') throw new Error('quote inside unquoted field')
      quoted = true
      i++
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
      i++
    } else if (ch === '\r') {
      if (text[i + 1] !== '\n') throw new Error('bare CR')
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i += 2
    } else if (ch === '\n') {
      throw new Error('bare LF outside quotes')
    } else {
      cell += ch
      i++
    }
  }
  if (quoted) throw new Error('unterminated quoted field')
  if (cell !== '' || row.length > 0) throw new Error('last record not terminated by CRLF')
  return rows
}

test('csvCell', async (t) => {
  await t.test('leaves plain values unchanged', () => {
    assert.equal(csvCell('Hello world'), 'Hello world')
    assert.equal(csvCell(''), '')
    assert.equal(csvCell('Björk; Sigur Rós'), 'Björk; Sigur Rós')
  })

  await t.test('quotes values with comma, quote, CR or LF and doubles quotes', () => {
    assert.equal(csvCell('a,b'), '"a,b"')
    assert.equal(csvCell('say "hi"'), '"say ""hi"""')
    assert.equal(csvCell('line\nbreak'), '"line\nbreak"')
    assert.equal(csvCell('cr\rlf'), '"cr\rlf"')
  })

  await t.test('does not escape formula-like values', () => {
    for (const v of ['=SUM(A1)', '+1', '-1', '@x']) assert.equal(csvCell(v), v)
  })
})

test('writeCSV', async (t) => {
  await t.test('writes the header and one row per track with CRLF endings', () => {
    const csv = writeCSV(samplePlaylistFile())
    const lines = csv.split('\r\n')
    assert.equal(lines[0], 'position,title,artists,album,duration_ms,added_at,isrc,ref')
    assert.equal(lines.at(-1), '', 'output ends with CRLF')
    assert.ok(!/(?<!\r)\n/.test(csv), 'no bare LF')
    assert.equal(lines.length, 1 + 3 + 1)
    assert.equal(lines[1], '1,Track 1,Artist A,Album,180000,2026-09-01T12:34:56Z,,spotify:track:t1')
    assert.equal(lines[2], '2,Track 2,B; C,Album,180000,2026-09-01T12:34:56Z,USRC17607839,spotify:track:t2')
  })

  await t.test('has no BOM', () => {
    const csv = writeCSV(samplePlaylistFile())
    assert.notEqual(csv.charCodeAt(0), 0xfeff)
    assert.equal(Buffer.from(csv, 'utf8')[0], 'p'.charCodeAt(0))
  })

  await t.test('skips unsupported items, leaving a gap in positions', () => {
    const rows = parseCSV(writeCSV(samplePlaylistFile()))
    assert.deepEqual(
      rows.slice(1).map((r) => r[0]),
      ['1', '2', '4']
    )
  })

  await t.test('writes empty cells for absent optional fields and null isrc', () => {
    const file = createPlaylistFile({
      generatorVersion: '0.1.0',
      exportedAt: EXPORTED_AT,
      source: { provider: 'fake', kind: 'playlist' },
      playlist: { name: 'Minimal' },
      tracks: [{ position: 1, title: 'T', artists: ['A'], isrc: null, refs: { other: 'x' } }],
    })
    const rows = parseCSV(writeCSV(file))
    assert.deepEqual(rows[1], ['1', 'T', 'A', '', '', '', '', ''])
  })

  await t.test('uses the source provider ref', () => {
    const file = samplePlaylistFile()
    file.tracks[0] = track(1, { refs: { 'youtube-music': 'yt1', spotify: 'spotify:track:abc' } })
    const rows = parseCSV(writeCSV(file))
    assert.equal(rows[1]![7], 'spotify:track:abc')
  })

  await t.test('round-trips quotes, commas, newlines and non-ASCII', () => {
    const tricky = [
      track(1, {
        title: 'He said "hello", then left',
        artists: ['Artist, Jr.', 'Ünïcödé "Q"'],
        album: 'Line one\r\nLine two\nLine three',
      }),
      track(2, { title: '坂本龍一 — Merry Christmas Mr. Lawrence 🎹', artists: ['坂本龍一'], album: 'Café del Mar' }),
      track(3, { title: '"', artists: ['""'], album: ',' }),
      track(4, { title: '=HYPERLINK("x")', artists: ['@handle'], album: '' }),
      track(5, { title: ' leading and trailing ', artists: ['Björk'], album: 'Ágætis byrjun\r' }),
    ]
    const file = samplePlaylistFile({ tracks: tricky, unsupportedItems: [] })
    file.playlist.trackCount = tricky.length
    const rows = parseCSV(writeCSV(file))

    assert.deepEqual(rows[0], [...CSV_COLUMNS])
    assert.equal(rows.length, 1 + tricky.length)
    rows.slice(1).forEach((r, i) => {
      const t = tricky[i]!
      assert.equal(r.length, CSV_COLUMNS.length)
      assert.deepEqual(r, [
        String(t.position),
        t.title,
        t.artists.join('; '),
        t.album ?? '',
        String(t.durationMs),
        t.addedAt,
        t.isrc ?? '',
        t.refs.spotify,
      ])
    })
  })

  await t.test('UTF-8 encoding round-trips non-ASCII bytes', () => {
    const file = samplePlaylistFile()
    file.tracks[0] = track(1, { title: 'Sigur Rós ✓ 🎵' })
    const csv = writeCSV(file)
    const decoded = Buffer.from(csv, 'utf8').toString('utf8')
    assert.equal(parseCSV(decoded)[1]![1], 'Sigur Rós ✓ 🎵')
  })

  await t.test('sorts rows by position', () => {
    const file = samplePlaylistFile()
    file.tracks.reverse()
    const rows = parseCSV(writeCSV(file))
    assert.deepEqual(
      rows.slice(1).map((r) => r[0]),
      ['1', '2', '4']
    )
  })

  await t.test('Liked Songs exports in the same CSV format', () => {
    const file = createPlaylistFile({
      generatorVersion: '0.1.0',
      exportedAt: EXPORTED_AT,
      source: { provider: 'spotify', kind: 'liked' },
      playlist: {},
      tracks: [track(1), track(2)],
    })
    assert.equal(file.source.kind, 'liked')
    assert.equal(file.playlist.name, 'Liked Songs')
    const rows = parseCSV(writeCSV(file))
    assert.deepEqual(rows[0], [...CSV_COLUMNS])
    assert.equal(rows.length, 3)
  })

  await t.test('empty playlist writes only the header', () => {
    const file = createPlaylistFile({
      generatorVersion: '0.1.0',
      exportedAt: EXPORTED_AT,
      source: { provider: 'spotify', kind: 'playlist' },
      playlist: { name: 'Empty' },
      tracks: [],
    })
    assert.equal(writeCSV(file), CSV_COLUMNS.join(',') + '\r\n')
  })

  await t.test('rejects an invalid file', () => {
    const file = samplePlaylistFile()
    file.playlist.trackCount = 0
    assert.throws(() => writeCSV(file), ExportFormatError)
  })
})
