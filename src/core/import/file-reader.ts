import { readFile } from 'fs/promises'
import type { CanonicalPlaylistFile } from '../export/format.js'

/**
 * Reads exported playlist files in JSON or CSV format and returns
 * CanonicalPlaylistFile for matching and import operations.
 */
export class CanonicalFileReader {
  /**
   * Read a canonical playlist file, detecting format by extension.
   * Supports JSON and CSV formats.
   */
  async readFile(path: string): Promise<CanonicalPlaylistFile> {
    const ext = path.toLowerCase().endsWith('.json') ? 'json' : 'csv'

    if (ext === 'json') {
      return this.readJson(path)
    } else {
      return this.readCsv(path)
    }
  }

  /**
   * Read and validate a JSON canonical playlist export file.
   * Validates schema version 1 and requires a tracks array.
   */
  private async readJson(path: string): Promise<CanonicalPlaylistFile> {
    const content = await readFile(path, 'utf-8')
    const data = JSON.parse(content)

    // Validate schema version
    if (data.schemaVersion !== 1) {
      throw new Error(
        `Unsupported schema version: ${data.schemaVersion}. This version of sple supports v1 only.`
      )
    }

    // Validate structure
    if (!data.tracks || !Array.isArray(data.tracks)) {
      throw new Error('Invalid file: missing or invalid tracks array')
    }

    return data as CanonicalPlaylistFile
  }

  /**
   * Read and parse a CSV canonical playlist export file.
   * Expected columns: position, title, artists, album, duration_ms, added_at, isrc, ref
   * Artists are semicolon-separated; fields may be quoted per RFC 4180.
   */
  private async readCsv(path: string): Promise<CanonicalPlaylistFile> {
    const content = await readFile(path, 'utf-8')
    const lines = content.split(/\r?\n/)

    if (lines.length < 2) {
      throw new Error('CSV file is empty or has no header')
    }

    const header = this.parseCsvLine(lines[0])
    const expectedColumns = ['position', 'title', 'artists', 'album', 'duration_ms', 'added_at', 'isrc', 'ref']

    if (!expectedColumns.every((col) => header.includes(col))) {
      throw new Error(`CSV header missing required columns. Expected: ${expectedColumns.join(', ')}`)
    }

    const tracks: any[] = []
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue

      const values = this.parseCsvLine(lines[i])
      const row = this.mapCsvRowToObject(header, values)

      // Parse artists as semicolon-separated list
      const artists = row.artists ? row.artists.split(';').map((a: string) => a.trim()).filter(Boolean) : []

      tracks.push({
        position: parseInt(row.position) || i,
        title: row.title,
        artists,
        album: row.album || '',
        durationMs: parseInt(row.duration_ms) || undefined,
        addedAt: row.added_at || undefined,
        isrc: row.isrc || undefined,
        // Create refs object with the ref value; since CSV doesn't indicate source provider,
        // we use a generic key. The import command would need to know the actual source provider.
        refs: row.ref ? { 'source': row.ref } : {},
      })
    }

    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      generator: { name: 'sple', version: 'unknown' },
      source: { provider: 'fake', kind: 'playlist' },
      playlist: {
        name: 'Imported Playlist',
        trackCount: tracks.length,
      },
      tracks,
      unsupportedItems: [],
    }
  }

  /**
   * Parse a single CSV line, handling quoted fields and escaped quotes per RFC 4180.
   * Returns an array of unquoted field values.
   */
  private parseCsvLine(line: string): string[] {
    const values: string[] = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
      const char = line[i]

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote: "" becomes "
          current += '"'
          i++
        } else {
          // Toggle quote state
          inQuotes = !inQuotes
        }
      } else if (char === ',' && !inQuotes) {
        // End of field
        values.push(current)
        current = ''
      } else {
        current += char
      }
    }

    values.push(current)
    return values
  }

  /**
   * Map a CSV row (array of values) to an object using header column names.
   */
  private mapCsvRowToObject(header: string[], values: string[]): Record<string, string> {
    const obj: Record<string, string> = {}
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = values[i] || ''
    }
    return obj
  }
}
