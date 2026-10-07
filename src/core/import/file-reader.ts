import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import type { CanonicalPlaylistFile, PositionedTrack } from '../export/format.js'
import { checkPlaylistFile } from '../export/format.js'
import type { ProviderId } from '../provider/capabilities.js'

/** A provider's pure `parseTrackRef` (ADR-0003 §3.1). */
export type TrackRefParser = (input: string) => string | null

export interface FileReaderOptions {
  /** `parseTrackRef` of every registered provider, for CSV source inference. */
  trackRefParsers?: Partial<Record<ProviderId, TrackRefParser>>
  /** Receives warnings meant for stderr. */
  onWarning?: (message: string) => void
}

export const CSV_SOURCE_UNKNOWN_WARNING =
  'sple: warning: could not tell which provider the CSV refs belong to; matching by metadata only'

const CSV_COLUMNS = ['position', 'title', 'artists', 'album', 'duration_ms', 'added_at', 'isrc', 'ref'] as const

/**
 * Reads exported playlist files for `sple import` (ADR-0008 Amendment 1,
 * "Reading"): `.json` must pass every v1 invariant; `.csv` is parsed per
 * RFC 4180 and its source provider is inferred from the refs.
 */
export class CanonicalFileReader {
  constructor(private options: FileReaderOptions = {}) {}

  async readFile(path: string): Promise<CanonicalPlaylistFile> {
    const ext = extname(path).toLowerCase()
    if (ext === '.json') return this.readJson(path)
    if (ext === '.csv') return this.readCsv(path)
    throw new Error(`Unsupported file type '${extname(path)}'; use .json or .csv`)
  }

  private async readJson(path: string): Promise<CanonicalPlaylistFile> {
    let data: CanonicalPlaylistFile
    try {
      data = JSON.parse(await readFile(path, 'utf-8')) as CanonicalPlaylistFile
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Invalid JSON: ${error.message}`)
      throw error
    }
    if (data?.schemaVersion !== 1) {
      throw new Error(
        `Unsupported schema version: ${data?.schemaVersion}. This version of sple supports v1 only.`
      )
    }
    const problems = checkPlaylistFile(data)
    if (problems.length > 0) {
      throw new Error(`Invalid canonical playlist file: ${problems.join('; ')}`)
    }
    return { ...data, tracks: [...data.tracks].sort((a, b) => a.position - b.position) }
  }

  private async readCsv(path: string): Promise<CanonicalPlaylistFile> {
    const [header, ...rows] = parseCsv((await readFile(path, 'utf-8')).replace(/^﻿/, ''))
    const column = new Map((header ?? []).map((name, i) => [name.trim(), i]))
    if (!CSV_COLUMNS.every((c) => column.has(c))) {
      throw new Error(`CSV header must contain the columns ${CSV_COLUMNS.join(',')}`)
    }

    const parsed: Array<{ track: PositionedTrack; ref: string }> = []
    rows.forEach((row, i) => {
      if (row.every((cell) => cell === '')) return
      const cell = (name: (typeof CSV_COLUMNS)[number]) => row[column.get(name)!] ?? ''
      const position = /^\d+$/.test(cell('position')) && Number(cell('position')) >= 1 ? Number(cell('position')) : i + 1
      const artists = cell('artists').split(';').map((a) => a.trim()).filter(Boolean)
      const track: PositionedTrack = {
        position,
        title: cell('title'),
        artists: artists.length > 0 ? artists : ['Unknown Artist'],
        refs: {},
      }
      if (cell('album')) track.album = cell('album')
      if (/^\d+$/.test(cell('duration_ms'))) track.durationMs = Number(cell('duration_ms'))
      if (cell('added_at')) track.addedAt = cell('added_at')
      if (cell('isrc')) track.isrc = cell('isrc')
      parsed.push({ track, ref: cell('ref').trim() })
    })

    const provider = this.inferSource(parsed.map((p) => p.ref).filter(Boolean))
    if (provider) {
      const parse = this.options.trackRefParsers![provider]!
      for (const { track, ref } of parsed) if (ref) track.refs[provider] = parse(ref)!
    } else {
      this.options.onWarning?.(CSV_SOURCE_UNKNOWN_WARNING)
    }

    const tracks = parsed.map((p) => p.track).sort((a, b) => a.position - b.position)
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      generator: { name: 'sple', version: 'unknown' },
      source: { provider: provider ?? 'unknown', kind: 'playlist' },
      playlist: { name: basename(path, extname(path)), trackCount: tracks.length },
      tracks,
      unsupportedItems: [],
    }
  }

  /** The single registered provider whose parseTrackRef accepts every ref, else undefined. */
  private inferSource(refs: string[]): ProviderId | undefined {
    const parsers = Object.entries(this.options.trackRefParsers ?? {}) as Array<[ProviderId, TrackRefParser]>
    const matching = parsers.filter(([, parse]) => refs.every((ref) => parse(ref) !== null))
    return matching.length === 1 ? matching[0][0] : undefined
  }
}

/** Parse RFC 4180 CSV into records; quoted fields may hold commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        inQuotes = false
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      record.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else {
      field += c
    }
  }
  // A final record without a trailing line break
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}
