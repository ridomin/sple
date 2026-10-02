import type { Provider } from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import { SpotifyAuth } from './auth.js'
import { parseSpotifyPlaylistRef } from './playlist-ref.js'
import { requiredScopes, type PlaylistVisibility, type SpotifyM1Operation } from './scopes.js'

const SPOTIFY_CAPABILITIES: ProviderCapabilities = {
  // isrcSearchMode and playlistItemsAccess from spikes S1/S2 (ADR-0003 Amendment 1)
  official: true,
  requiresRiskAcknowledgement: false,
  userSuppliedClientId: true,
  requiresClientSecret: false,
  supportsRefreshToken: true,
  supportsRevocation: false,
  paginationModel: 'offset',
  maxSearchPageSize: 10,
  playlistItemsAccess: 'owned-or-collaborator',
  likedSongs: { read: 'exact', write: false },
  isrcSearchMode: 'filter',
  searchReturnsDuration: true,
  musicAwareSearch: true,
  canDeletePlaylist: false,
  supportsCollaborative: true,
  maxTracksPerRequest: 100,
  quotaModel: { kind: 'rate-limited' },
}

const notImplemented = (): Promise<never> => Promise.reject(new Error('Not implemented'))

export function createSpotifyProvider(clientId: string, configDir?: string): Provider {
  const auth = new SpotifyAuth(clientId, configDir)

  /** Scope check (M1-11) that runs before every M1 operation's API call. */
  const guard = async (op: SpotifyM1Operation, visibility?: PlaylistVisibility): Promise<void> => {
    await auth.requireScopes(requiredScopes(op, visibility))
  }

  // API calls arrive in M1-19..M1-21; until then each operation checks scopes, then rejects.
  return {
    id: 'spotify',
    displayName: 'Spotify',
    capabilities: SPOTIFY_CAPABILITIES,
    auth,
    parsePlaylistRef: parseSpotifyPlaylistRef,
    search: () => guard('search').then(notImplemented),
    listPlaylists: () => guard('listPlaylists').then(notImplemented),
    // Reading a (possibly private) playlist's metadata needs the same scope as its items.
    getPlaylist: () => guard('getPlaylistItems').then(notImplemented),
    getPlaylistTracks: () => guard('getPlaylistItems').then(notImplemented),
    getLikedTracks: () => guard('readLiked').then(notImplemented),
    createPlaylist: (input) =>
      guard('createPlaylist', { public: input.public, collaborative: input.collaborative }).then(
        notImplemented
      ),
    removePlaylist: () => guard('removePlaylist').then(notImplemented),
    // Not M1 operations: no scope in the M1 table.
    resolveTrack: notImplemented,
    populatePlaylist: notImplemented,
  }
}
