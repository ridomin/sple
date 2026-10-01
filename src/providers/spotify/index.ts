import type { Provider } from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import { SpotifyAuth } from './auth.js'

const SPOTIFY_CAPABILITIES: ProviderCapabilities = {
  // Stub capabilities; real values in M1
  official: true,
  requiresRiskAcknowledgement: false,
  userSuppliedClientId: true,
  requiresClientSecret: false,
  supportsRefreshToken: true,
  supportsRevocation: false,
  paginationModel: 'offset',
  maxSearchPageSize: 10,
  playlistItemsAccess: 'owned-only',
  likedSongs: { read: 'exact', write: false },
  isrcSearchMode: 'filter',
  searchReturnsDuration: true,
  musicAwareSearch: true,
  canDeletePlaylist: false,
  supportsCollaborative: true,
  maxTracksPerRequest: 100,
  quotaModel: { kind: 'rate-limited' },
}

export const SPOTIFY_PROVIDER: Provider = {
  id: 'spotify',
  displayName: 'Spotify',
  capabilities: SPOTIFY_CAPABILITIES,
  auth: new SpotifyAuth(process.env.SPLE_SPOTIFY_CLIENT_ID || ''),
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
