import { ProviderError } from '../../core/provider/errors.js'

/**
 * Hand-written type guards for Spotify API responses.
 * Validates structure without external dependencies (no zod, no JSON Schema).
 */

export interface SpotifyTrack {
  id: string
  name: string
  artists: Array<{ name: string }>
  album?: { name: string }
  duration_ms?: number | null
  external_ids?: { isrc?: string }
  uri: string
  is_local?: boolean
}

export interface SpotifyUser {
  id: string
  display_name?: string
}

export interface SpotifyPlaylist {
  id: string
  name: string
  description?: string | null
  owner: { id: string; display_name?: string }
  items?: {
    total: number
    items?: Array<SpotifyPlaylistItem>
  }
}

export interface SpotifyPlaylistItem {
  added_at?: string
  is_local?: boolean
  item: SpotifyTrack | SpotifyEpisode | null
  position?: number
}

export interface SpotifyEpisode {
  id: string
  name: string
  type: 'episode'
}

/**
 * Validate and narrow a value to SpotifyTrack.
 * Throws ProviderError if validation fails.
 */
export function validateSpotifyTrack(value: unknown): SpotifyTrack {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderError(`Invalid Spotify track: must be an object (received: ${typeof value})`)
  }
  const obj = value as Record<string, unknown>

  // Required fields
  if (typeof obj.id !== 'string' || !obj.id) {
    throw new ProviderError(
      `Invalid Spotify track: missing or invalid 'id' field (received: ${JSON.stringify(obj.id)})`
    )
  }

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new ProviderError(
      `Invalid Spotify track: missing or invalid 'name' field (received: ${JSON.stringify(obj.name)})`
    )
  }

  if (typeof obj.uri !== 'string' || !obj.uri) {
    throw new ProviderError(
      `Invalid Spotify track: missing or invalid 'uri' field (received: ${JSON.stringify(obj.uri)})`
    )
  }

  // Artists array
  if (!Array.isArray(obj.artists)) {
    throw new ProviderError(
      `Invalid Spotify track: 'artists' must be an array (received: ${typeof obj.artists})`
    )
  }

  // Validate each artist has a name
  for (let i = 0; i < obj.artists.length; i++) {
    const artist = obj.artists[i]
    if (!artist || typeof artist !== 'object' || typeof (artist as Record<string, unknown>).name !== 'string') {
      throw new ProviderError(
        `Invalid Spotify track: artist at index ${i} missing 'name' field`
      )
    }
  }

  // Optional fields
  if (obj.duration_ms !== undefined && obj.duration_ms !== null) {
    if (typeof obj.duration_ms !== 'number') {
      throw new ProviderError(
        `Invalid Spotify track: 'duration_ms' must be a number (received: ${typeof obj.duration_ms})`
      )
    }
  }

  return obj as unknown as SpotifyTrack
}

/**
 * Validate and narrow a value to SpotifyUser.
 * Throws ProviderError if validation fails.
 */
export function validateSpotifyUser(value: unknown): SpotifyUser {
  const obj = value as Record<string, unknown>

  if (typeof obj.id !== 'string' || !obj.id) {
    throw new ProviderError(
      `Invalid Spotify user: missing or invalid 'id' field (received: ${JSON.stringify(obj.id)})`
    )
  }

  return obj as unknown as SpotifyUser
}

/**
 * Validate and narrow a value to SpotifyPlaylist.
 * Throws ProviderError if validation fails.
 */
export function validateSpotifyPlaylist(value: unknown): SpotifyPlaylist {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderError(`Invalid Spotify playlist: must be an object (received: ${typeof value})`)
  }
  const obj = value as Record<string, unknown>

  if (typeof obj.id !== 'string' || !obj.id) {
    throw new ProviderError(
      `Invalid Spotify playlist: missing or invalid 'id' field (received: ${JSON.stringify(obj.id)})`
    )
  }

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new ProviderError(
      `Invalid Spotify playlist: missing or invalid 'name' field (received: ${JSON.stringify(obj.name)})`
    )
  }

  if (!obj.owner || typeof obj.owner !== 'object') {
    throw new ProviderError(
      `Invalid Spotify playlist: missing or invalid 'owner' field (received: ${typeof obj.owner})`
    )
  }

  const owner = obj.owner as Record<string, unknown>
  if (typeof owner.id !== 'string' || !owner.id) {
    throw new ProviderError(
      `Invalid Spotify playlist: owner missing or invalid 'id' field (received: ${JSON.stringify(owner.id)})`
    )
  }

  // Items is optional but if present should have total
  if (obj.items !== undefined && obj.items !== null) {
    if (typeof obj.items !== 'object') {
      throw new ProviderError(
        `Invalid Spotify playlist: 'items' must be an object (received: ${typeof obj.items})`
      )
    }

    const items = obj.items as Record<string, unknown>
    if (typeof items.total !== 'number') {
      throw new ProviderError(
        `Invalid Spotify playlist: 'items.total' must be a number (received: ${typeof items.total})`
      )
    }
  }

  return obj as unknown as SpotifyPlaylist
}

/**
 * Validate and narrow a value to SpotifyPlaylistItem array.
 * Throws ProviderError if validation fails.
 */
export function validateSpotifyPlaylistItems(value: unknown): SpotifyPlaylistItem[] {
  if (!Array.isArray(value)) {
    throw new ProviderError(
      `Invalid Spotify playlist items: must be an array (received: ${typeof value})`
    )
  }

  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (!item || typeof item !== 'object') {
      throw new ProviderError(
        `Invalid Spotify playlist item at index ${i}: must be an object (received: ${typeof item})`
      )
    }

    const itemObj = item as Record<string, unknown>

    // item field should be track, episode, or null
    if (itemObj.item !== undefined && itemObj.item !== null) {
      if (typeof itemObj.item !== 'object') {
        throw new ProviderError(
          `Invalid Spotify playlist item at index ${i}: 'item' must be an object or null (received: ${typeof itemObj.item})`
        )
      }

      const itemContent = itemObj.item as Record<string, unknown>
      // Validate it's either a track or episode by checking type field
      if (
        itemContent.type !== 'track' &&
        itemContent.type !== 'episode'
      ) {
        throw new ProviderError(
          `Invalid Spotify playlist item at index ${i}: 'item.type' must be 'track' or 'episode' (received: ${JSON.stringify(itemContent.type)})`
        )
      }
    }
  }

  return value as unknown as SpotifyPlaylistItem[]
}

/**
 * Type guard to check if an item's track is a track (not episode).
 */
export function isSpotifyTrackType(item: SpotifyPlaylistItem | { item: unknown }): boolean {
  if (!item.item || typeof item.item !== 'object') {
    return false
  }
  const trackObj = item.item as Record<string, unknown>
  return trackObj.type === 'track'
}

/**
 * Type guard to check if an item's track is an episode.
 */
export function isSpotifyEpisodeType(item: SpotifyPlaylistItem | { item: unknown }): boolean {
  if (!item.item || typeof item.item !== 'object') {
    return false
  }
  const trackObj = item.item as Record<string, unknown>
  return trackObj.type === 'episode'
}

export interface SpotifyArtist {
  id: string
  name: string
  uri: string
  type: 'artist'
}

export interface SpotifyAlbum {
  id: string
  name: string
  uri: string
  type: 'album'
  artists: Array<{ name: string }>
  release_date?: string
  total_tracks?: number
}

export interface SpotifyPlaylistSearchResult {
  id: string
  name: string
  uri: string
  type: 'playlist'
  owner: { id: string; display_name?: string }
  tracks?: { total: number }
}

export interface SpotifySearchResponse {
  tracks?: { items: SpotifyTrack[]; total: number; offset: number; limit: number; next?: string | null }
  albums?: { items: SpotifyAlbum[]; total: number; offset: number; limit: number; next?: string | null }
  artists?: { items: SpotifyArtist[]; total: number; offset: number; limit: number; next?: string | null }
  playlists?: { items: SpotifyPlaylistSearchResult[]; total: number; offset: number; limit: number; next?: string | null }
}

/**
 * Validate and narrow a value to SpotifySearchResponse.
 * Throws ProviderError if validation fails.
 */
export function validateSpotifySearchResponse(value: unknown): SpotifySearchResponse {
  const obj = value as Record<string, unknown>

  // Response must be an object with at least one search type
  if (!obj || typeof obj !== 'object') {
    throw new ProviderError(
      `Invalid Spotify search response: must be an object (received: ${typeof obj})`
    )
  }

  // At least one result type must be present
  const hasResults = obj.tracks || obj.albums || obj.artists || obj.playlists
  if (!hasResults) {
    throw new ProviderError(
      'Invalid Spotify search response: must contain at least one result type (tracks, albums, artists, or playlists)'
    )
  }

  for (const key of ['tracks', 'albums', 'artists', 'playlists'] as const) {
    const section = obj[key]
    if (section === undefined) continue
    if (!section || typeof section !== 'object' || !Array.isArray((section as Record<string, unknown>).items)) {
      throw new ProviderError(`Invalid Spotify search response: ${key}.items must be an array`)
    }
  }

  return obj as unknown as SpotifySearchResponse
}

/** A Spotify paging object (`GET /me/playlists`, `/playlists/{id}/items`, `/me/tracks`). */
export interface SpotifyPage {
  items: unknown[]
  total: number
  next?: string | null
}

/**
 * Validate the container of a paged Spotify response. Item contents are
 * validated by the mappers. `what` names the endpoint in error messages.
 * Throws ProviderError (never a TypeError) on malformed input.
 */
export function validateSpotifyPage(value: unknown, what: string): SpotifyPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderError(`Invalid Spotify ${what} response: must be an object (received: ${typeof value})`)
  }
  const obj = value as Record<string, unknown>
  if (!Array.isArray(obj.items)) {
    throw new ProviderError(`Invalid Spotify ${what} response: 'items' must be an array`)
  }
  if (typeof obj.total !== 'number' || !Number.isInteger(obj.total) || obj.total < 0) {
    throw new ProviderError(`Invalid Spotify ${what} response: 'total' must be a non-negative integer`)
  }
  if (obj.next !== undefined && obj.next !== null && typeof obj.next !== 'string') {
    throw new ProviderError(`Invalid Spotify ${what} response: 'next' must be a string or null`)
  }
  return { items: obj.items, total: obj.total, next: obj.next as string | null | undefined }
}

/** One entry of `GET /me/tracks` (saved tracks). */
export interface SpotifySavedTrack {
  added_at?: string
  track: unknown
}

export function validateSpotifySavedTrack(value: unknown, index: number): SpotifySavedTrack {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderError(`Invalid Spotify saved track at index ${index}: must be an object`)
  }
  const obj = value as Record<string, unknown>
  return {
    added_at: typeof obj.added_at === 'string' ? obj.added_at : undefined,
    track: obj.track,
  }
}
