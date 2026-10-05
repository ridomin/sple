import {
  assertPlaylistFile,
  type CanonicalPlaylistFile,
  type PositionedTrack,
  type UnsupportedPlaylistItem,
} from './format.js'

/**
 * Copy only the fields defined by the v1 format, in a fixed key order, so
 * extra runtime properties never leak into the file and output is stable.
 * `undefined` values are dropped by JSON.stringify; `isrc: null` is kept.
 */
function normalizeTrack(t: PositionedTrack): PositionedTrack {
  return {
    position: t.position,
    title: t.title,
    artists: [...t.artists],
    album: t.album,
    durationMs: t.durationMs,
    isrc: t.isrc,
    addedAt: t.addedAt,
    refs: { ...t.refs },
  }
}

function normalizeUnsupported(u: UnsupportedPlaylistItem): UnsupportedPlaylistItem {
  return { position: u.position, kind: u.kind, name: u.name, ref: u.ref }
}

export function normalizePlaylistFile(file: CanonicalPlaylistFile): CanonicalPlaylistFile {
  const p = file.playlist
  return {
    schemaVersion: file.schemaVersion,
    exportedAt: file.exportedAt,
    generator: { name: file.generator.name, version: file.generator.version },
    source: { provider: file.source.provider, kind: file.source.kind, userId: file.source.userId },
    playlist: {
      ref: p.ref,
      id: p.id,
      name: p.name,
      description: p.description,
      owner: p.owner ? { id: p.owner.id, displayName: p.owner.displayName } : undefined,
      public: p.public,
      collaborative: p.collaborative,
      url: p.url,
      trackCount: p.trackCount,
    },
    tracks: [...file.tracks].sort((a, b) => a.position - b.position).map(normalizeTrack),
    unsupportedItems: [...file.unsupportedItems]
      .sort((a, b) => a.position - b.position)
      .map(normalizeUnsupported),
  }
}

/**
 * Serialize a canonical playlist file (ADR 0008) as UTF-8 JSON text:
 * 2-space indent, trailing newline. Throws `ExportFormatError` if the file
 * breaks a v1 invariant.
 */
export function writeJSON(file: CanonicalPlaylistFile): string {
  assertPlaylistFile(file)
  return JSON.stringify(normalizePlaylistFile(file), null, 2) + '\n'
}
