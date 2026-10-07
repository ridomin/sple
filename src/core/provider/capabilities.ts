export type ProviderId = 'spotify' | 'youtube-music' | 'fake'

export type ProviderOperation =
  | 'search'
  | 'searchTracks'
  | 'listPlaylists'
  | 'getPlaylistItems'
  | 'createPlaylist'
  | 'updatePlaylist'
  | 'removePlaylist'
  | 'populatePlaylist'
  | 'readLiked'

export interface QuotaBucket {
  id: string
  dailyLimit: number
  resetTimeZone: string
}

export interface QuotaCost {
  bucket: string
  amount: number
  per: 'call' | 'page' | 'item'
  pageSize?: number
}

export type QuotaModel =
  | { kind: 'rate-limited' }
  | {
      kind: 'daily-buckets'
      buckets: QuotaBucket[]
      costs: Partial<Record<ProviderOperation, QuotaCost[]>>
    }
  | { kind: 'undocumented'; minDelayMs: number; maxBatch: number }

export interface ProviderCapabilities {
  official: boolean
  requiresRiskAcknowledgement: boolean

  userSuppliedClientId: boolean
  requiresClientSecret: boolean
  supportsRefreshToken: boolean
  supportsRevocation: boolean

  paginationModel: 'offset' | 'cursor-forward'
  maxSearchPageSize: number
  /** Page size of list/items/liked reads (ADR-0003 A2). */
  readPageSize: { playlists: number; playlistItems: number; liked: number }
  playlistItemsAccess: 'all' | 'owned-only' | 'owned-or-collaborator'
  likedSongs: { read: 'exact' | 'approximate' | 'none'; write: false; readCap?: number }

  isrcSearchMode: 'lookup' | 'filter' | 'none'
  searchReturnsDuration: boolean
  musicAwareSearch: boolean

  canDeletePlaylist: boolean
  supportsCollaborative: boolean
  /** populatePlaylist batch size; writes only, never a read page size. */
  maxTracksPerRequest: number
  maxPlaylistSize?: number

  quotaModel: QuotaModel
}
