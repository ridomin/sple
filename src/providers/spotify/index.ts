import type { Provider, PageRequest, PlaylistSummary, CanonicalTrack, SearchItem } from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import { UsageError, AccessRestrictedError } from '../../core/provider/errors.js'
import { SpotifyAuth } from './auth.js'
import { parseSpotifyPlaylistRef } from './playlist-ref.js'
import { requiredScopes, type PlaylistVisibility, type SpotifyM1Operation } from './scopes.js'
import { mapSpotifyPlaylistToSummary, determineItemsReadable, mapSpotifyPlaylistItems, mapSpotifyTrackToCanonical, mapSpotifySearchResults } from './mappers.js'
import { loadTokens } from '../../core/config/token-store.js'

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
    async search(q, page) {
      await guard('search')
      const token = loadTokens('spotify', configDir)
      if (!token) throw new Error('No token found')

      const limit = Math.min(page.limit, SPOTIFY_CAPABILITIES.maxSearchPageSize)
      const offset = page.offset || 0

      // Build query string with all requested types
      const typeParam = q.type
      const queryParam = encodeURIComponent(q.text)
      const path = `/search?q=${queryParam}&type=${typeParam}&limit=${limit}&offset=${offset}`

      interface SearchResponse {
        tracks?: { items: Array<Record<string, unknown>> }
        albums?: { items: Array<Record<string, unknown>> }
        artists?: { items: Array<Record<string, unknown>> }
        playlists?: { items: Array<Record<string, unknown>> }
      }

      const response = await auth.getApi<SearchResponse>(path, token.accessToken)

      const items: SearchItem[] = mapSpotifySearchResults(response)

      // Calculate if there are more results based on what we got
      // For now, we don't have total count from the response structure in a uniform way,
      // so we indicate next only if we got a full page (limit items)
      const hasMore = items.length >= limit
      const next = hasMore ? { offset: offset + limit } : undefined

      return { items, next }
    },

    async listPlaylists(page: PageRequest) {
      await guard('listPlaylists')
      const token = loadTokens('spotify', configDir)
      if (!token) throw new Error('No token found')

      const limit = Math.min(page.limit, 50)
      const offset = page.offset || 0
      const path = `/me/playlists?limit=${limit}&offset=${offset}`

      interface PlaylistsResponse {
        items: Array<Record<string, unknown>>
        total: number
      }

      const response = await auth.getApi<PlaylistsResponse>(path, token.accessToken)

      const items: PlaylistSummary[] = response.items.map((item) => {
        const owner = item.owner as Record<string, unknown> | undefined
        const isOwned = owner?.id === token.userId
        const isCollaborative = item.collaborative === true
        const itemsReadable = determineItemsReadable(
          SPOTIFY_CAPABILITIES.playlistItemsAccess,
          isOwned || false,
          isCollaborative
        )
        return mapSpotifyPlaylistToSummary(item, token.userId, itemsReadable)
      })

      const next =
        offset + limit < response.total ? { offset: offset + limit } : undefined

      return { items, total: response.total, next }
    },

    async getPlaylist(ref: string) {
      await guard('getPlaylistItems')
      const token = loadTokens('spotify', configDir)
      if (!token) throw new Error('No token found')

      const response = await auth.getApi<Record<string, unknown>>(
        `/playlists/${ref}`,
        token.accessToken
      )

      const owner = response.owner as Record<string, unknown> | undefined
      const isOwned = owner?.id === token.userId
      const isCollaborative = response.collaborative === true
      const itemsReadable = determineItemsReadable(
        SPOTIFY_CAPABILITIES.playlistItemsAccess,
        isOwned || false,
        isCollaborative
      )

      return mapSpotifyPlaylistToSummary(response, token.userId, itemsReadable)
    },

    async getPlaylistTracks(ref: string, page: PageRequest) {
      await guard('getPlaylistItems')
      const token = loadTokens('spotify', configDir)
      if (!token) throw new Error('No token found')

      // First, fetch the playlist to check access
      const playlist = await auth.getApi<Record<string, unknown>>(
        `/playlists/${ref}`,
        token.accessToken
      )

      const owner = playlist.owner as Record<string, unknown> | undefined
      const isOwned = owner?.id === token.userId
      const isCollaborative = playlist.collaborative === true
      const itemsReadable = determineItemsReadable(
        SPOTIFY_CAPABILITIES.playlistItemsAccess,
        isOwned || false,
        isCollaborative
      )

      // Access control: fail fast if not readable
      if (!itemsReadable) {
        throw new AccessRestrictedError(
          'You do not have permission to read items from this playlist. ' +
            'Copy it to an owned playlist in the Spotify app to read it here.',
          'not-owned'
        )
      }

      // Then fetch the items
      const limit = Math.min(page.limit, SPOTIFY_CAPABILITIES.maxTracksPerRequest)
      const offset = page.offset || 0
      const path = `/playlists/${ref}/items?limit=${limit}&offset=${offset}`

      try {
        interface ItemsResponse {
          items: Array<Record<string, unknown>>
          total: number
        }

        const response = await auth.getApi<ItemsResponse>(path, token.accessToken)

        const mappedItems = mapSpotifyPlaylistItems(response.items, offset + 1)
        const items: CanonicalTrack[] = mappedItems
          .filter((item) => item.track)
          .map((item) => item.track!)

        const next =
          offset + limit < response.total ? { offset: offset + limit } : undefined

        return { items, total: response.total, next }
      } catch (error) {
        // If we get 403/404 and thought it was readable, re-check
        if (
          (error instanceof AccessRestrictedError || error instanceof Error) &&
          itemsReadable
        ) {
          const msg = (error as Error).message
          if (msg.includes('403') || msg.includes('404')) {
            throw new AccessRestrictedError(
              'Playlist access has changed. You may no longer have permission to read this playlist.',
              'not-owned'
            )
          }
        }
        throw error
      }
    },

    async getLikedTracks(page: PageRequest) {
      await guard('readLiked')
      const token = loadTokens('spotify', configDir)
      if (!token) throw new Error('No token found')

      const limit = Math.min(page.limit, SPOTIFY_CAPABILITIES.maxTracksPerRequest)
      const offset = page.offset || 0
      const path = `/me/tracks?limit=${limit}&offset=${offset}`

      interface LikedTracksResponse {
        items: Array<Record<string, unknown>>
        total: number
      }

      const response = await auth.getApi<LikedTracksResponse>(path, token.accessToken)

      const items: CanonicalTrack[] = response.items
        .map((item) => {
          const track = item.track
          if (!track) return null

          const canonical = mapSpotifyTrackToCanonical(track)
          // Preserve added_at from the liked tracks response
          if (typeof item.added_at === 'string') {
            canonical.addedAt = item.added_at
          }
          return canonical
        })
        .filter((item): item is CanonicalTrack => item !== null)

      const next =
        offset + limit < response.total ? { offset: offset + limit } : undefined

      return { items, total: response.total, next }
    },
    async createPlaylist(input) {
      // Validation: collaborative + public is rejected by Spotify before API call (FR-PL-3)
      if (input.collaborative && input.public) {
        throw new UsageError(
          'Spotify does not support public collaborative playlists. Use either public or collaborative, not both.'
        )
      }

      // Scope check (M1-11)
      await guard('createPlaylist', { public: input.public, collaborative: input.collaborative })

      // Get token for API call
      const token = await auth.requireScopes(
        requiredScopes('createPlaylist', { public: input.public, collaborative: input.collaborative })
      )

      // Make API call
      const response = await auth.createPlaylist(input, token.accessToken)

      // Map response to PlaylistSummary
      const itemsReadable = determineItemsReadable(
        SPOTIFY_CAPABILITIES.playlistItemsAccess,
        true, // newly created by user
        input.collaborative ?? false
      )
      return mapSpotifyPlaylistToSummary(response, token.userId, itemsReadable)
    },
    async removePlaylist(ref) {
      // Scope check (M1-11)
      await guard('removePlaylist')

      // Get token for API call
      const token = await auth.requireScopes(requiredScopes('removePlaylist'))

      // Make API call
      await auth.removePlaylist(ref, token.accessToken)

      return { action: 'unfollowed' }
    },
    // Not M1 operations: no scope in the M1 table.
    resolveTrack: () =>
      Promise.reject(new UsageError('Track resolution is not available in this release')),
    populatePlaylist: () =>
      Promise.reject(new UsageError('Playlist population is not available in this release')),
  }
}
