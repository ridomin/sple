import { assertPlaylistFile, type CanonicalPlaylistFile, type PositionedTrack } from './format.js'

/** CSV header, in column order (ADR 0008 §4). */
export const CSV_COLUMNS = [
  'position',
  'title',
  'artists',
  'album',
  'duration_ms',
  'added_at',
  'isrc',
  'ref',
] as const

/** Separator used to join `artists` into one cell. */
export const CSV_ARTIST_SEPARATOR = '; '

const CRLF = '\r\n'
const NEEDS_QUOTING = /[",\r\n]/

/**
 * Quote a cell per RFC 4180 when it contains a double quote, comma, CR or LF;
 * embedded quotes are doubled. Values are otherwise written unchanged (no
 * formula-injection escaping; see ADR 0008).
 */
export function csvCell(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function row(cells: readonly string[]): string {
  return cells.map(csvCell).join(',') + CRLF
}

function trackRow(t: PositionedTrack, provider: string): string[] {
  return [
    String(t.position),
    t.title,
    t.artists.join(CSV_ARTIST_SEPARATOR),
    t.album ?? '',
    t.durationMs === undefined ? '' : String(t.durationMs),
    t.addedAt ?? '',
    t.isrc ?? '',
    t.refs[provider] ?? '',
  ]
}

/**
 * Serialize a canonical playlist file as CSV (FR-EXP-3): RFC 4180, CRLF line
 * endings (including after the last row), header row first, one row per
 * track in position order. Returned as a JS string; callers write it as UTF-8
 * without a BOM. Unsupported items are not written (JSON keeps them), so
 * positions may have gaps. `ref` is the track ref for `source.provider`.
 */
export function writeCSV(file: CanonicalPlaylistFile): string {
  assertPlaylistFile(file)
  const tracks = [...file.tracks].sort((a, b) => a.position - b.position)
  let out = row(CSV_COLUMNS)
  for (const t of tracks) out += row(trackRow(t, file.source.provider))
  return out
}
