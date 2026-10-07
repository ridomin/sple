import type { ProviderId } from '../provider/capabilities.js'
import type { CanonicalTrack } from '../provider/provider.js'

/**
 * Canonical playlist file, version 1 (ADR 0008, FR-EXP-2).
 *
 * This is the lossless hand-off format for export and, later, import and
 * migration. The JSON Schema is `schemas/canonical-playlist.v1.schema.json`.
 * Any change to this shape is a schema change and needs an ADR 0008 amendment.
 */
export interface CanonicalPlaylistFile {
  schemaVersion: 1
  /** ISO 8601 UTC, e.g. `2026-10-02T12:34:56.789Z`. */
  exportedAt: string
  generator: { name: 'sple'; version: string }
  source: {
    /** `unknown` only for a CSV whose refs name no single provider (ADR-0008 A1). */
    provider: ProviderId | 'unknown'
    kind: ExportSourceKind
    userId?: string
  }
  playlist: {
    ref?: string
    id?: string
    name: string
    description?: string
    owner?: { id: string; displayName?: string }
    public?: boolean
    collaborative?: boolean
    url?: string
    /** Number of items in this file: `tracks.length + unsupportedItems.length`. */
    trackCount: number
  }
  /** 1-based `position` in the source playlist's order. */
  tracks: PositionedTrack[]
  unsupportedItems: UnsupportedPlaylistItem[]
}

export type ExportSourceKind = 'playlist' | 'liked'

export type PositionedTrack = CanonicalTrack & { position: number }

/** Same shape as ADR 0007 `UnsupportedItem`. */
export interface UnsupportedPlaylistItem {
  /** 1-based, shares the position space with `tracks`. */
  position: number
  kind: 'local' | 'episode' | 'unavailable'
  name?: string
  ref?: string
}

export const SCHEMA_VERSION = 1 as const

/** Display name used for the saved-tracks library (FR-EXP-6). */
export const LIKED_SONGS_NAME = 'Liked Songs'

/** Repository/package path of the JSON Schema for this format. */
export const SCHEMA_PATH = 'schemas/canonical-playlist.v1.schema.json'

/** Thrown when a file does not satisfy the v1 format invariants. */
export class ExportFormatError extends Error {
  constructor(
    message: string,
    public readonly problems: string[]
  ) {
    super(message)
    this.name = this.constructor.name
    Object.setPrototypeOf(this, ExportFormatError.prototype)
  }
}

export interface CreatePlaylistFileInput {
  generatorVersion: string
  source: CanonicalPlaylistFile['source']
  /** Playlist metadata; ignored fields: `trackCount` is computed. For `liked`, `name` defaults to "Liked Songs". */
  playlist: Omit<CanonicalPlaylistFile['playlist'], 'trackCount' | 'name'> & { name?: string }
  tracks: PositionedTrack[]
  unsupportedItems?: UnsupportedPlaylistItem[]
  /** Defaults to now. */
  exportedAt?: Date
}

/**
 * Assemble a v1 file. Computes `trackCount`, fills `generator`, and forces
 * `playlist.name` to "Liked Songs" when `source.kind` is `liked`.
 */
export function createPlaylistFile(input: CreatePlaylistFileInput): CanonicalPlaylistFile {
  const unsupportedItems = input.unsupportedItems ?? []
  const name =
    input.source.kind === 'liked' ? LIKED_SONGS_NAME : (input.playlist.name ?? '')
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    generator: { name: 'sple', version: input.generatorVersion },
    source: input.source,
    playlist: {
      ...input.playlist,
      name,
      trackCount: input.tracks.length + unsupportedItems.length,
    },
    tracks: input.tracks,
    unsupportedItems,
  }
}

const UTC_ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const UNSUPPORTED_KINDS = new Set(['local', 'episode', 'unavailable'])

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1
}

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

/**
 * Check the invariants of a v1 file, including those the JSON Schema cannot
 * express (unique positions, `trackCount` consistency). Returns a list of
 * problems; empty means valid. No runtime schema-validator dependency.
 */
export function checkPlaylistFile(file: CanonicalPlaylistFile): string[] {
  const problems: string[] = []
  if (file.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion must be ${SCHEMA_VERSION}`)
  if (typeof file.exportedAt !== 'string' || !UTC_ISO_8601.test(file.exportedAt)) {
    problems.push('exportedAt must be an ISO 8601 UTC timestamp')
  }
  if (file.generator?.name !== 'sple' || typeof file.generator.version !== 'string' || !file.generator.version) {
    problems.push('generator must be { name: "sple", version: <non-empty string> }')
  }
  if (!file.source || typeof file.source.provider !== 'string' || !file.source.provider) {
    problems.push('source.provider is required')
  }
  if (file.source?.kind !== 'playlist' && file.source?.kind !== 'liked') {
    problems.push('source.kind must be "playlist" or "liked"')
  }
  if (!file.playlist || typeof file.playlist.name !== 'string') {
    problems.push('playlist.name is required')
  } else if (file.source?.kind === 'liked' && file.playlist.name !== LIKED_SONGS_NAME) {
    problems.push(`playlist.name must be "${LIKED_SONGS_NAME}" when source.kind is "liked"`)
  }
  if (!Array.isArray(file.tracks)) problems.push('tracks must be an array')
  if (!Array.isArray(file.unsupportedItems)) problems.push('unsupportedItems must be an array')
  if (problems.length > 0) return problems

  const seen = new Set<number>()
  const checkPosition = (where: string, position: unknown): void => {
    if (!isPositiveInt(position)) {
      problems.push(`${where}.position must be an integer >= 1`)
      return
    }
    if (seen.has(position)) problems.push(`${where}.position ${position} is used more than once`)
    seen.add(position)
  }

  file.tracks.forEach((t, i) => {
    const where = `tracks[${i}]`
    checkPosition(where, t.position)
    if (typeof t.title !== 'string') problems.push(`${where}.title must be a string`)
    if (!Array.isArray(t.artists) || t.artists.length === 0 || t.artists.some((a) => typeof a !== 'string')) {
      problems.push(`${where}.artists must be a non-empty array of strings`)
    }
    if (t.durationMs !== undefined && !isNonNegativeInt(t.durationMs)) {
      problems.push(`${where}.durationMs must be a non-negative integer`)
    }
    if (t.isrc !== undefined && t.isrc !== null && typeof t.isrc !== 'string') {
      problems.push(`${where}.isrc must be a string or null`)
    }
    if (t.addedAt !== undefined && (typeof t.addedAt !== 'string' || !ISO_8601.test(t.addedAt))) {
      problems.push(`${where}.addedAt must be an ISO 8601 timestamp`)
    }
    if (!t.refs || typeof t.refs !== 'object' || Object.keys(t.refs).length === 0) {
      problems.push(`${where}.refs must contain at least one provider ref`)
    }
  })

  file.unsupportedItems.forEach((u, i) => {
    const where = `unsupportedItems[${i}]`
    checkPosition(where, u.position)
    if (!UNSUPPORTED_KINDS.has(u.kind)) problems.push(`${where}.kind must be local, episode or unavailable`)
  })

  const expected = file.tracks.length + file.unsupportedItems.length
  if (file.playlist.trackCount !== expected) {
    problems.push(`playlist.trackCount must equal tracks + unsupportedItems (${expected})`)
  }
  return problems
}

/** Throw `ExportFormatError` if the file breaks a v1 invariant. */
export function assertPlaylistFile(file: CanonicalPlaylistFile): void {
  const problems = checkPlaylistFile(file)
  if (problems.length > 0) {
    throw new ExportFormatError(`Invalid canonical playlist file: ${problems.join('; ')}`, problems)
  }
}
