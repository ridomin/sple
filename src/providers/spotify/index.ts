import type { Provider, PageRequest, PlaylistFilter, PlaylistSummary, CanonicalTrack, SearchItem } from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import { UsageError, AccessRestrictedError, NotFoundError } from '../../core/provider/errors.js'
import { SpotifyAuth } from './auth.js'
import { parseSpotifyPlaylistRef } from './playlist-ref.js'
import { requiredScopes, type PlaylistVisibility, type SpotifyM1Operation } from './scopes.js'
import { mapSpotifyPlaylistToSummary, determineItemsReadable, mapSpotifyPlaylistItems, mapSpotifyTrackToCanonical, mapSpotifySearchResults } from './mappers.js'
import { loadTokens } from '../../core/config/token-store.js'
import { validateSpotifySearchResponse } from './schemas.js'

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


/** S3 page-size limit for GET /me/tracks. */
const LIKED_TRACKS_MAX_LIMIT = 50

const NOT_READABLE_MESSAGE =
  'Spotify only returns the tracks of playlists you own or collaborate on, and this playlist is neither. ' +
  'Workaround: in the Spotify app, copy its tracks into a playlist you own (or ask the owner to add you ' +
  'as a collaborator), then use that playlist.'

const ACCESS_CHANGED_MESSAGE =
  'Spotify refused to return the tracks of this playlist, although it looked readable. Access may have ' +
  'changed (for example, you were removed as a collaborator). Spotify only returns the tracks of playlists ' +
  'you own or collaborate on; copy its tracks into a playlist you own in the Spotify app, then use that playlist.'

/**
 * Resolve a playlist ref (ID, URI or URL) to a bare Spotify playlist ID.
 * Names must be resolved by the caller (playlist resolver) first.
 */
function playlistId(ref: string): string {
  const id = parseSpotifyPlaylistRef(ref)
  if (!id) {
    throw new UsageError(`"${ref}" is not a Spotify playlist ID, URI or URL`)
  }
  return id
}

/**
 * itemsReadable for a playlist object (S2, capability 'owned-or-collaborator').
 * Ownership: owner.id === current user ID. Collaborator access: S2 found that
 * the `collaborative` flag is unreliable (a playlist the user collaborates on
 * was recorded with `collaborative: false`); the reliable signal is that
 * `GET /playlists/{id}` includes an `items` key only when the user can read
 * the items. A non-owned playlist without `items` is not readable.
 */
function itemsReadableFor(playlist: Record<string, unknown>, userId: string): boolean {
  const owner = playlist.owner as Record<string, unknown> | undefined
  const isOwned = owner?.id === userId
  const hasCollaboratorAccess = playlist.items !== undefined && playlist.items !== null
  return determineItemsReadable(SPOTIFY_CAPABILITIES.playlistItemsAccess, isOwned, hasCollaboratorAccess)
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
      // Scope check (M1-11): search needs a logged-in user (AuthRequiredError, exit 3) but no scope.
      const token = await auth.requireScopes(requiredScopes('search'))

      // One request per call; callers split larger limits with paginate() (src/core/search.ts).
      const limit = Math.min(page.limit, SPOTIFY_CAPABILITIES.maxSearchPageSize)
      const offset = page.offset ?? 0

      const params = new URLSearchParams({
        q: q.text,
        type: q.type,
        limit: String(limit),
        offset: String(offset),
      })
      const raw = await auth.getApi<unknown>(`/search?${params.toString()}`, token.accessToken)
      const response = validateSpotifySearchResponse(raw)

      const items: SearchItem[] = mapSpotifySearchResults(response)

      // More results exist when Spotify returns a `next` URL for the requested type,
      // or (if `next` is missing) when offset + returned page is below `total`.
      const typeKey = `${q.type}s` as 'tracks' | 'albums' | 'artists' | 'playlists'
      const section = response[typeKey]
      const total = typeof section?.total === 'number' ? section.total : undefined
      const pageCount = section?.items.length ?? items.length
      let hasMore: boolean
      if (section && 'next' in section) {
        hasMore = typeof section.next === 'string' && section.next.length > 0
      } else {
        hasMore = total !== undefined && offset + pageCount < total
      }
      const next = hasMore ? { offset: offset + pageCount } : undefined

      return { items, total, next }
    },

    async listPlaylists(page: PageRequest, filter?: PlaylistFilter) {
      await guard('listPlaylists')
      const token = loadTokens('spotify', configDir)
      if (!token) throw new Error('No token found')

      const limit = Math.min(page.limit, 50)
      const offset = page.offset || 0
      // Spotify has no server-side owner filter on GET /me/playlists, so the
      // filter is applied to each page after mapping (owner.id === me.id).
      const path = `/me/playlists?limit=${limit}&offset=${offset}`

      interface PlaylistsResponse {
        items: Array<Record<string, unknown>>
        total: number
      }

      const response = await auth.getApi<PlaylistsResponse>(path, token.accessToken)

      const all: PlaylistSummary[] = response.items.map((item) =>
        mapSpotifyPlaylistToSummary(item, token.userId, itemsReadableFor(item, token.userId))
      )
      const items =
        filter === 'owned'
          ? all.filter((p) => p.owned)
          : filter === 'followed'
            ? all.filter((p) => !p.owned)
            : all

      const next =
        offset + limit < response.total ? { offset: offset + limit } : undefined

      // The Spotify total counts unfiltered playlists, so omit it when filtering.
      return filter ? { items, next } : { items, total: response.total, next }
    },

    async getPlaylist(ref: string) {
      await guard('getPlaylistItems')
      const token = loadTokens('spotify', configDir)
      if (!token) throw new Error('No token found')

      const id = playlistId(ref)
      const response = await auth.getApi<Record<string, unknown>>(
        `/playlists/${id}`,
        token.accessToken
      )

      return mapSpotifyPlaylistToSummary(response, token.userId, itemsReadableFor(response, token.userId))
    },

    async getPlaylistTracks(ref: string, page: PageRequest) {
      await guard('getPlaylistItems')
      const token = loadTokens('spotify', configDir)
      if (!token) throw new Error('No token found')

      const id = playlistId(ref)

      // First, fetch the playlist to check access (S2)
      const playlist = await auth.getApi<Record<string, unknown>>(
        `/playlists/${id}`,
        token.accessToken
      )

      // Access control: fail fast, before any /items request
      if (!itemsReadableFor(playlist, token.userId)) {
        throw new AccessRestrictedError(NOT_READABLE_MESSAGE, 'not-owned')
      }

      const limit = Math.min(page.limit, SPOTIFY_CAPABILITIES.maxTracksPerRequest)
      const offset = page.offset || 0
      const path = `/playlists/${id}/items?limit=${limit}&offset=${offset}`

      interface ItemsResponse {
        items: Array<Record<string, unknown>>
        total: number
      }

      let response: ItemsResponse
      try {
        response = await auth.getApi<ItemsResponse>(path, token.accessToken)
      } catch (error) {
        // The playlist looked readable, but /items returned the S2 "not readable"
        // signal (403 or 404): access changed since the playlist was fetched.
        // Key on the error type, never on message text. Premium-required 403s
        // keep their own reason and pass through unchanged.
        if (
          error instanceof NotFoundError ||
          (error instanceof AccessRestrictedError && error.reason === 'other')
        ) {
          throw new AccessRestrictedError(ACCESS_CHANGED_MESSAGE, 'not-owned')
        }
        throw error
      }

      const items: CanonicalTrack[] = mapSpotifyPlaylistItems(response.items, offset + 1)
        .filter((item) => item.track)
        .map((item) => item.track!)

      const next =
        offset + limit < response.total ? { offset: offset + limit } : undefined

      return { items, total: response.total, next }
    },

    async getLikedTracks(page: PageRequest) {
      await guard('readLiked')
      const token = loadTokens('spotify', configDir)
      if (!token) throw new Error('No token found')

      // S3: GET /me/tracks accepts at most 50 per page
      const limit = Math.min(page.limit, LIKED_TRACKS_MAX_LIMIT)
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
