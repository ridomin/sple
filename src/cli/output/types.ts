import type {
  CanonicalTrack,
  PlaylistSummary,
  SearchItem,
  ProviderId,
} from '../../core/provider/index.js'

/**
 * JSON output type definitions per ADR-0007.
 * These types define the contract for --json output across all CLI commands.
 */

export interface PageInfo {
  /** Present when more results exist; pass back as --offset (offset providers). */
  next?: { offset?: number; cursor?: string }
  /** Total results reported by the provider, when it reports one. */
  total?: number
}

export interface UnsupportedItem {
  position: number // 1-based, in the playlist's order
  kind: 'local' | 'episode' | 'unavailable'
  name?: string
  ref?: string
}

export interface ErrorInfo {
  type: string // error class name
  message: string
  exitCode: number
}

export interface ErrorOutput {
  error: ErrorInfo
}

// sple search
export interface SearchOutput extends PageInfo {
  items: SearchItem[]
}

// sple playlist list
export interface PlaylistListOutput extends PageInfo {
  playlists: PlaylistSummary[]
}

// sple playlist show
export interface PlaylistShowOutput {
  playlist: PlaylistSummary
  tracks: Array<CanonicalTrack & { position: number }> // position 1-based
  unsupportedItems: UnsupportedItem[]
}

// sple playlist create
export type PlaylistCreateOutput =
  | {
      dryRun: false
      id: string
      ref: string
      name: string
      description?: string
      url?: string
      owner: { id: string; displayName?: string }
      public: boolean
      collaborative: boolean
    }
  | {
      dryRun: true // nothing created, so no id/ref/url/owner
      name: string
      description?: string
      public: boolean
      collaborative: boolean
    }

// sple playlist remove
export interface PlaylistRemoveOutput {
  dryRun: boolean
  /** From capabilities.canDeletePlaylist: false → 'unfollowed' (Spotify), true → 'deleted'. */
  action: 'unfollowed' | 'deleted'
  playlist: { id: string; ref: string; name: string }
}

// sple export
export interface ExportOutput {
  files: Array<{
    path: string // absolute path written
    format: 'json' | 'csv'
    source: { kind: 'playlist' | 'liked'; id?: string; name: string }
    trackCount: number
    unsupportedCount: number
  }>
  skipped: Array<{
    input: string // the ref as given on the command line or stdin
    error: ErrorInfo
  }>
}

// sple auth status
export interface AuthStatusOutput {
  providers: Array<{
    id: ProviderId
    loggedIn: boolean
    user?: { id: string; displayName?: string }
    scopes: string[] // granted scopes; empty when not logged in
    expiresAt?: string // access-token expiry, ISO 8601 UTC
  }>
}
