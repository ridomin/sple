/** YouTube Data API scopes (ADR-0003 YouTube scope table, FR-AUTH-5). */
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube'
export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'
export const GOOGLE_PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.profile'

/** Requested at login: `youtube` covers reads and writes; the profile scope gives the account name. */
export const YOUTUBE_LOGIN_SCOPES: readonly string[] = [YOUTUBE_SCOPE, GOOGLE_PROFILE_SCOPE]

export type YouTubeOperation =
  | 'search' | 'searchTracks' | 'listPlaylists' | 'getPlaylist' | 'getPlaylistTracks' | 'getLikedTracks'
  | 'createPlaylist' | 'removePlaylist' | 'populatePlaylist'

const READ = [YOUTUBE_SCOPE, YOUTUBE_READONLY_SCOPE] as const
const WRITE = [YOUTUBE_SCOPE] as const

/**
 * Scopes that satisfy each operation: any one of the listed scopes is enough.
 * The first entry is the one named in a missing-scope error, because it is
 * the one `sple auth login` requests.
 */
export const YOUTUBE_OPERATION_SCOPES: Readonly<Record<YouTubeOperation, readonly string[]>> = {
  search: READ,
  searchTracks: READ,
  listPlaylists: READ,
  getPlaylist: READ,
  getPlaylistTracks: READ,
  getLikedTracks: READ,
  createPlaylist: WRITE,
  removePlaylist: WRITE,
  populatePlaylist: WRITE,
}
