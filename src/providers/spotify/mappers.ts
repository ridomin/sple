import type { CanonicalTrack, PlaylistSummary, SearchItem } from '../../core/provider/provider.js'
import type { UnsupportedItem } from '../../cli/output/types.js'
import { ProviderError } from '../../core/provider/errors.js'
import {
  validateSpotifyTrack,
  validateSpotifyPlaylist,
  validateSpotifyPlaylistItems,
  isSpotifyTrackType,
  isSpotifyEpisodeType,
  validateSpotifySearchResponse,
  type SpotifyTrack,
  type SpotifyPlaylist,
  type SpotifyPlaylistItem,
  type SpotifySearchResponse,
  type SpotifyArtist,
  type SpotifyAlbum,
  type SpotifyPlaylistSearchResult,
} from './schemas.js'

/**
 * Convert a Spotify track response to a CanonicalTrack.
 * @param track - Raw Spotify track object (will be validated)
 * @returns CanonicalTrack with isrc set to null per ADR-0005
 */
export function mapSpotifyTrackToCanonical(track: unknown): CanonicalTrack {
  let validated: SpotifyTrack

  try {
    validated = validateSpotifyTrack(track)
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error
    }
    throw new ProviderError(`Failed to map Spotify track: ${String(error)}`)
  }

  const artists =
    validated.artists && validated.artists.length > 0
      ? validated.artists.map((a) => a.name)
      : ['Unknown Artist']

  const canonical: CanonicalTrack = {
    title: validated.name || '(untitled)',
    artists,
    refs: {
      spotify: validated.uri || '(no uri)',
    },
    isrc: null, // ADR-0005: Spotify does not provide ISRC
  }

  // Optional fields
  if (validated.album?.name) {
    canonical.album = validated.album.name
  }

  if (validated.duration_ms !== undefined && validated.duration_ms !== null) {
    canonical.durationMs = validated.duration_ms
  }

  return canonical
}

/**
 * A single item returned from mapSpotifyPlaylistItems.
 * It's either a canonical track or an unsupported item.
 */
export interface MappedPlaylistItem {
  track?: CanonicalTrack
  position: number
  unsupported?: UnsupportedItem
}

/**
 * Convert Spotify playlist items response to a list of tracks and unsupported items.
 * Maintains order and position numbering (1-based).
 *
 * @param itemsData - Raw Spotify playlist items (items array from /playlists/{id}/items)
 * @param startPosition - Starting position number (defaults to 1)
 * @returns Array of mapped items with position tracking
 */
export function mapSpotifyPlaylistItems(
  itemsData: unknown,
  startPosition: number = 1
): MappedPlaylistItem[] {
  let validated: SpotifyPlaylistItem[]

  try {
    validated = validateSpotifyPlaylistItems(itemsData)
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error
    }
    throw new ProviderError(`Failed to map Spotify playlist items: ${String(error)}`)
  }

  const results: MappedPlaylistItem[] = []

  for (let i = 0; i < validated.length; i++) {
    const item = validated[i]
    const position = startPosition + i

    // Handle local tracks
    if (item.is_local === true) {
      const unsupported: UnsupportedItem = {
        position,
        kind: 'local',
      }

      // Add name if available
      if (item.item && typeof item.item === 'object') {
        const trackObj = item.item as unknown as Record<string, unknown>
        if (typeof trackObj.name === 'string') {
          unsupported.name = trackObj.name
        }
        if (typeof trackObj.uri === 'string') {
          unsupported.ref = trackObj.uri
        }
      }

      results.push({ position, unsupported })
      continue
    }

    // Handle null item (unavailable)
    if (item.item === null) {
      results.push({
        position,
        unsupported: {
          position,
          kind: 'unavailable',
        },
      })
      continue
    }

    // Handle episodes
    if (isSpotifyEpisodeType(item)) {
      const trackObj = item.item as unknown as Record<string, unknown>
      const unsupported: UnsupportedItem = {
        position,
        kind: 'episode',
      }

      if (typeof trackObj.name === 'string') {
        unsupported.name = trackObj.name
      }
      if (typeof trackObj.id === 'string') {
        unsupported.ref = `spotify:episode:${trackObj.id}`
      }

      results.push({ position, unsupported })
      continue
    }

    // Handle regular tracks
    if (isSpotifyTrackType(item)) {
      try {
        const canonical = mapSpotifyTrackToCanonical(item.item)
        // Playlist items carry when the track was added (ADR-0005 addedAt).
        if (typeof item.added_at === 'string') {
          canonical.addedAt = item.added_at
        }
        results.push({ position, track: canonical })
      } catch (error) {
        // Re-throw with context
        if (error instanceof ProviderError) {
          throw error
        }
        throw new ProviderError(
          `Failed to map track at position ${position}: ${String(error)}`
        )
      }
      continue
    }

    // Unexpected type
    const trackObj = item.item as unknown as Record<string, unknown>
    throw new ProviderError(
      `Invalid track type at position ${position}: expected 'track' or 'episode', got '${JSON.stringify(trackObj.type)}'`
    )
  }

  return results
}

/**
 * Convert a Spotify playlist response to a PlaylistSummary.
 *
 * @param playlist - Raw Spotify playlist object (will be validated)
 * @param userId - Current user ID (from token store) to determine ownership
 * @param itemsReadable - Whether the current user can read items (based on capabilities.playlistItemsAccess)
 * @returns PlaylistSummary
 */
export function mapSpotifyPlaylistToSummary(
  playlist: unknown,
  userId: string,
  itemsReadable: boolean
): PlaylistSummary {
  let validated: SpotifyPlaylist

  try {
    validated = validateSpotifyPlaylist(playlist)
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error
    }
    throw new ProviderError(`Failed to map Spotify playlist: ${String(error)}`)
  }

  const owned = validated.owner.id === userId
  let trackCount: number | undefined

  // Get track count from items.total (not from playlist.tracks)
  if (validated.items?.total !== undefined) {
    trackCount = validated.items.total
  }

  const summary: PlaylistSummary = {
    ref: validated.id,
    id: validated.id,
    name: validated.name || '(untitled)',
    owner: {
      id: validated.owner.id,
      displayName: validated.owner.display_name,
    },
    owned,
    // itemsReadable is determined by capabilities and ownership:
    // - 'all': always true
    // - 'owned-only': true only if owned
    // - 'owned-or-collaborator': true if owned or collaborative
    // For now, use the provided parameter (caller handles capability logic)
    itemsReadable,
    trackCount,
  }

  // Add optional fields if present
  if (validated.description) {
    summary.description = validated.description
  }

  // Add visibility fields from Spotify response
  const publicFlag = (validated as unknown as Record<string, unknown>).public
  if (typeof publicFlag === 'boolean') {
    summary.public = publicFlag
  }

  const collaborativeFlag = (validated as unknown as Record<string, unknown>).collaborative
  if (typeof collaborativeFlag === 'boolean') {
    summary.collaborative = collaborativeFlag
  }

  // Add URL (construct from ID)
  summary.url = `https://open.spotify.com/playlist/${validated.id}`

  return summary
}

/**
 * Build the itemsReadable boolean based on capabilities and playlist access.
 * Per M1-7 and capabilities.playlistItemsAccess.
 *
 * @param playlistItemsAccess - From provider capabilities: 'all', 'owned-only', or 'owned-or-collaborator'
 * @param isOwned - Whether the current user owns the playlist
 * @param isCollaborative - Whether the playlist is collaborative (optional)
 * @returns true if items can be read
 */
export function determineItemsReadable(
  playlistItemsAccess: 'all' | 'owned-only' | 'owned-or-collaborator',
  isOwned: boolean,
  isCollaborative: boolean = false
): boolean {
  if (playlistItemsAccess === 'all') {
    return true
  }
  if (playlistItemsAccess === 'owned-only') {
    return isOwned
  }
  if (playlistItemsAccess === 'owned-or-collaborator') {
    return isOwned || isCollaborative
  }
  return false
}

/**
 * Convert a Spotify track search result to a SearchItem.
 */
function mapSpotifySearchTrack(track: SpotifyTrack): SearchItem {
  const canonical = mapSpotifyTrackToCanonical(track)
  return {
    id: track.id,
    ref: track.uri,
    url: `https://open.spotify.com/track/${track.id}`,
    name: track.name || '(untitled)',
    type: 'track',
    track: canonical,
  }
}

/**
 * Convert a Spotify album search result to a SearchItem.
 */
function mapSpotifySearchAlbum(album: SpotifyAlbum): SearchItem {
  const artists = album.artists && album.artists.length > 0
    ? album.artists.map((a) => a.name)
    : ['Unknown Artist']

  return {
    id: album.id,
    ref: album.uri,
    url: `https://open.spotify.com/album/${album.id}`,
    name: album.name || '(untitled)',
    type: 'album',
    artists,
    releaseDate: album.release_date,
    trackCount: album.total_tracks,
  }
}

/**
 * Convert a Spotify artist search result to a SearchItem.
 */
function mapSpotifySearchArtist(artist: SpotifyArtist): SearchItem {
  return {
    id: artist.id,
    ref: artist.uri,
    url: `https://open.spotify.com/artist/${artist.id}`,
    name: artist.name || '(unnamed)',
    type: 'artist',
  }
}

/**
 * Convert a Spotify playlist search result to a SearchItem.
 */
function mapSpotifySearchPlaylist(playlist: SpotifyPlaylistSearchResult): SearchItem {
  return {
    id: playlist.id,
    ref: playlist.uri,
    url: `https://open.spotify.com/playlist/${playlist.id}`,
    name: playlist.name || '(untitled)',
    type: 'playlist',
    owner: {
      id: playlist.owner.id,
      displayName: playlist.owner.display_name,
    },
    trackCount: playlist.tracks?.total,
  }
}

/**
 * Convert Spotify search response to SearchItem array.
 * Filters out unsupported types (episodes, etc.) silently.
 *
 * @param response - Raw Spotify search response (will be validated)
 * @returns Array of SearchItem objects
 */
export function mapSpotifySearchResults(response: unknown): SearchItem[] {
  let validated: SpotifySearchResponse

  try {
    validated = validateSpotifySearchResponse(response)
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error
    }
    throw new ProviderError(`Failed to validate Spotify search response: ${String(error)}`)
  }

  const results: SearchItem[] = []

  // Map tracks
  if (validated.tracks?.items) {
    for (const track of validated.tracks.items) {
      if (!track) continue
      try {
        results.push(mapSpotifySearchTrack(track))
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error
        }
        throw new ProviderError(`Failed to map search track: ${String(error)}`)
      }
    }
  }

  // Map albums
  if (validated.albums?.items) {
    for (const album of validated.albums.items) {
      if (!album) continue
      try {
        results.push(mapSpotifySearchAlbum(album))
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error
        }
        throw new ProviderError(`Failed to map search album: ${String(error)}`)
      }
    }
  }

  // Map artists
  if (validated.artists?.items) {
    for (const artist of validated.artists.items) {
      if (!artist) continue
      try {
        results.push(mapSpotifySearchArtist(artist))
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error
        }
        throw new ProviderError(`Failed to map search artist: ${String(error)}`)
      }
    }
  }

  // Map playlists
  if (validated.playlists?.items) {
    for (const playlist of validated.playlists.items) {
      // Skip unavailable playlists (null items in response)
      if (!playlist) {
        continue
      }
      try {
        results.push(mapSpotifySearchPlaylist(playlist))
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error
        }
        throw new ProviderError(`Failed to map search playlist: ${String(error)}`)
      }
    }
  }

  return results
}
