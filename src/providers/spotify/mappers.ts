import type { CanonicalTrack, PlaylistSummary } from '../../core/provider/provider.js'
import type { UnsupportedItem } from '../../cli/output/types.js'
import { ProviderError } from '../../core/provider/errors.js'
import {
  validateSpotifyTrack,
  validateSpotifyPlaylist,
  validateSpotifyPlaylistItems,
  isSpotifyTrackType,
  isSpotifyEpisodeType,
  type SpotifyTrack,
  type SpotifyPlaylist,
  type SpotifyPlaylistItem,
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
    title: validated.name,
    artists,
    refs: {
      spotify: validated.uri,
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
    name: validated.name,
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
