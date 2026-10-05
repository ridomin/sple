import type { ProviderOperation } from '../../core/provider/capabilities.js'
import { AuthRequiredError } from '../../core/provider/errors.js'

/** Spotify operations used by M1 commands. Later operations add their scopes here. */
export type SpotifyM1Operation = Extract<
  ProviderOperation,
  'search' | 'listPlaylists' | 'getPlaylistItems' | 'readLiked' | 'createPlaylist' | 'removePlaylist'
>

/** Visibility of the playlist being created; decides which modify scope is needed. */
export interface PlaylistVisibility {
  public: boolean
  collaborative?: boolean
}

/**
 * Scope table (FR-AUTH-5, M1-11). Each entry lists every scope the operation
 * needs. `createPlaylist` lists the union; `requiredScopes` narrows it by visibility.
 *
 * - `removePlaylist` unfollows via `DELETE /me/library?uris=spotify:playlist:<id>`.
 *   Spike S4(b) is unverified, so it requires both modify scopes (the playlist's
 *   visibility is not known before the call). If S4(b) shows a 403 for private
 *   playlists, add `user-library-modify` here.
 * - `search` needs a logged-in user but no scope.
 */
export const SPOTIFY_OPERATION_SCOPES: Readonly<Record<SpotifyM1Operation, readonly string[]>> = {
  search: [],
  listPlaylists: ['playlist-read-private', 'playlist-read-collaborative'],
  getPlaylistItems: ['playlist-read-private'],
  readLiked: ['user-library-read'],
  createPlaylist: ['playlist-modify-public', 'playlist-modify-private'],
  removePlaylist: ['playlist-modify-public', 'playlist-modify-private'],
}

/** Scopes requested at login: the union of the M1 table, and nothing more. */
export const SPOTIFY_LOGIN_SCOPES: readonly string[] = [
  ...new Set(Object.values(SPOTIFY_OPERATION_SCOPES).flat()),
]

/** Scopes needed for one call of `op`. */
export function requiredScopes(op: SpotifyM1Operation, visibility?: PlaylistVisibility): string[] {
  if (op === 'createPlaylist') {
    if (!visibility) return [...SPOTIFY_OPERATION_SCOPES.createPlaylist]
    // Collaborative playlists are private on Spotify but editable by others: both.
    if (visibility.collaborative) return ['playlist-modify-public', 'playlist-modify-private']
    return [visibility.public ? 'playlist-modify-public' : 'playlist-modify-private']
  }
  return [...SPOTIFY_OPERATION_SCOPES[op]]
}

/** Throw `AuthRequiredError('missing-scope')` naming the first required scope not granted. */
export function assertScopes(granted: readonly string[], required: readonly string[]): void {
  const missing = required.find((s) => !granted.includes(s))
  if (missing !== undefined) {
    throw new AuthRequiredError(`Run "sple auth login" to grant ${missing}`, 'missing-scope', missing)
  }
}
