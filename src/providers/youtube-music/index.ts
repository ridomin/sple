import type { Provider } from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import { YouTubeMusicAuth } from './auth.js'

const YOUTUBE_MUSIC_CAPABILITIES: ProviderCapabilities = {
  official: true,
  requiresRiskAcknowledgement: false,
  userSuppliedClientId: true,
  requiresClientSecret: true,
  supportsRefreshToken: true,
  supportsRevocation: true,
  paginationModel: 'cursor-forward',
  maxSearchPageSize: 50,
  playlistItemsAccess: 'all',
  likedSongs: { read: 'approximate', write: false, readCap: 5000 },
  isrcSearchMode: 'none',
  searchReturnsDuration: false,
  musicAwareSearch: false,
  canDeletePlaylist: true,
  supportsCollaborative: false,
  maxTracksPerRequest: 1,
  quotaModel: { kind: 'rate-limited' },
}

export function createYouTubeMusicProvider(
  clientId: string,
  clientSecret: string,
  configDir?: string
): Provider {
  return {
    id: 'youtube-music',
    displayName: 'YouTube Music',
    capabilities: YOUTUBE_MUSIC_CAPABILITIES,
    auth: new YouTubeMusicAuth(clientId, clientSecret, configDir),
    // Ref parsing lands with the YouTube Music adapter; until then every input
    // falls back to name lookup.
    parsePlaylistRef: () => null,
    search: () => Promise.reject(new Error('Not implemented')),
    listPlaylists: () => Promise.reject(new Error('Not implemented')),
    getPlaylist: () => Promise.reject(new Error('Not implemented')),
    getPlaylistTracks: () => Promise.reject(new Error('Not implemented')),
    getLikedTracks: () => Promise.reject(new Error('Not implemented')),
    createPlaylist: () => Promise.reject(new Error('Not implemented')),
    removePlaylist: () => Promise.reject(new Error('Not implemented')),
    resolveTrack: () => Promise.reject(new Error('Not implemented')),
    populatePlaylist: () => Promise.reject(new Error('Not implemented')),
  }
}
