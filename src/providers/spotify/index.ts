import type { Provider, PageRequest, PlaylistFilter, PlaylistSummary, CanonicalTrack, SearchItem } from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import {
  UsageError,
  AccessRestrictedError,
  NotFoundError,
  ProviderError,
  isFatalProviderError,
} from '../../core/provider/errors.js'
import { HttpClient, type HttpLogEntry } from '../../core/http/client.js'
import { SpotifyAuth } from './auth.js'
import { parseSpotifyPlaylistRef } from './playlist-ref.js'
import { requiredScopes, type PlaylistVisibility, type SpotifyM1Operation } from './scopes.js'
import { mapSpotifyPlaylistToSummary, determineItemsReadable, mapSpotifyPlaylistItems, mapSpotifyTrackToCanonical, mapSpotifySearchResults } from './mappers.js'
import { mapSpotifyHttpError } from './errors.js'
import {
  validateSpotifySearchResponse,
  validateSpotifyPage,
  validateSpotifySavedTrack,
  type SpotifyPage,
} from './schemas.js'

export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1'
/** Canonical Spotify track ref (ADR-0003 §3.1). */
const SPOTIFY_TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/

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

/** Object-shaped JSON body (a single Spotify object such as a playlist). */
function validateObject(what: string): (x: unknown) => Record<string, unknown> {
  return (x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      throw new ProviderError(`Invalid Spotify ${what} response: must be an object`)
    }
    return x as Record<string, unknown>
  }
}

/** `next` for an offset page, from the reported `total`. */
function nextOffset(page: SpotifyPage, offset: number, limit: number): { offset: number } | undefined {
  return offset + limit < page.total ? { offset: offset + limit } : undefined
}

export interface SpotifyProviderOptions {
  /** Receives one entry per HTTP attempt, for `--debug` logging (ADR 0007 §6). */
  onHttp?: (entry: HttpLogEntry) => void
}

export function createSpotifyProvider(
  clientId: string,
  configDir?: string,
  options: SpotifyProviderOptions = {}
): Provider {
  const auth = new SpotifyAuth(clientId, configDir)

  // One HTTP client per provider instance: bearer injection, proactive and
  // reactive (401) refresh with single-flight, Retry-After-aware 429/5xx
  // retries, and Spotify error mapping (M1-12, PRV-4). SpotifyAuth.refresh
  // persists the refreshed token itself, so no configDir is passed here.
  const http = new HttpClient({
    providerId: 'spotify',
    getToken: () => auth.getToken(),
    refresh: (token) => auth.refresh(token),
    mapError: mapSpotifyHttpError,
    onResponse: options.onHttp,
  })

  const getJson = <T>(path: string, validate: (x: unknown) => T): Promise<T> =>
    http.requestJson({ method: 'GET', url: `${SPOTIFY_API_BASE}${path}` }, validate)

  /**
   * Scope check (M1-11) that runs before every M1 operation's API call.
   * Returns the stored token (for the current user's ID); no token → exit 3.
   */
  const guard = (op: SpotifyM1Operation, visibility?: PlaylistVisibility) =>
    auth.requireScopes(requiredScopes(op, visibility))

  /**
   * Item readability per playlist ID, so paging through a playlist checks
   * access once instead of re-fetching the playlist for every page.
   */
  const readable = new Map<string, boolean>()

  /** Every track URI already in a playlist (for populatePlaylist's skipExisting). */
  const playlistTrackUris = async (id: string): Promise<Set<string>> => {
    const uris = new Set<string>()
    const limit = SPOTIFY_CAPABILITIES.maxTracksPerRequest
    for (let offset: number | undefined = 0; offset !== undefined; ) {
      const response: SpotifyPage = await getJson(`/playlists/${id}/items?limit=${limit}&offset=${offset}`, (x) =>
        validateSpotifyPage(x, 'playlist items')
      )
      for (const item of mapSpotifyPlaylistItems(response.items, offset + 1)) {
        const u = item.track?.refs.spotify
        if (u) uris.add(u)
      }
      offset = nextOffset(response, offset, limit)?.offset
    }
    return uris
  }

  const fetchPlaylist = async (id: string, userId: string) => {
    const raw = await getJson(`/playlists/${id}`, validateObject('playlist'))
    const itemsReadable = itemsReadableFor(raw, userId)
    readable.set(id, itemsReadable)
    return mapSpotifyPlaylistToSummary(raw, userId, itemsReadable)
  }

  return {
    id: 'spotify',
    displayName: 'Spotify',
    capabilities: SPOTIFY_CAPABILITIES,
    auth,
    parsePlaylistRef: parseSpotifyPlaylistRef,
    async search(q, page) {
      // Scope check (M1-11): search needs a logged-in user (AuthRequiredError, exit 3) but no scope.
      await guard('search')

      // One request per call; callers split larger limits with paginate() (src/core/search.ts).
      const limit = Math.min(page.limit, SPOTIFY_CAPABILITIES.maxSearchPageSize)
      const offset = page.offset ?? 0

      const params = new URLSearchParams({
        q: q.text,
        type: q.type,
        limit: String(limit),
        offset: String(offset),
      })
      const response = await getJson(`/search?${params.toString()}`, validateSpotifySearchResponse)

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
      const token = await guard('listPlaylists')

      const limit = Math.min(page.limit, 50)
      const offset = page.offset || 0
      // Spotify has no server-side owner filter on GET /me/playlists, so the
      // filter is applied to each page after mapping (owner.id === me.id).
      const response = await getJson(`/me/playlists?limit=${limit}&offset=${offset}`, (x) =>
        validateSpotifyPage(x, 'playlists')
      )

      const all: PlaylistSummary[] = response.items.map((item) => {
        const obj = validateObject('playlist')(item)
        return mapSpotifyPlaylistToSummary(obj, token.userId, itemsReadableFor(obj, token.userId))
      })
      const items =
        filter === 'owned'
          ? all.filter((p) => p.owned)
          : filter === 'followed'
            ? all.filter((p) => !p.owned)
            : all

      const next = nextOffset(response, offset, limit)

      // The Spotify total counts unfiltered playlists, so omit it when filtering.
      return filter ? { items, next } : { items, total: response.total, next }
    },

    async getPlaylist(ref: string) {
      const token = await guard('getPlaylistItems')
      return fetchPlaylist(playlistId(ref), token.userId)
    },

    async getPlaylistTracks(ref: string, page: PageRequest) {
      const token = await guard('getPlaylistItems')
      const id = playlistId(ref)

      // Access check (S2), once per playlist: fail fast, before any /items request.
      let itemsReadable = readable.get(id)
      if (itemsReadable === undefined) {
        itemsReadable = (await fetchPlaylist(id, token.userId)).itemsReadable
      }
      if (!itemsReadable) {
        throw new AccessRestrictedError(NOT_READABLE_MESSAGE, 'not-owned')
      }

      const limit = Math.min(page.limit, SPOTIFY_CAPABILITIES.maxTracksPerRequest)
      const offset = page.offset || 0

      let response: SpotifyPage
      try {
        response = await getJson(`/playlists/${id}/items?limit=${limit}&offset=${offset}`, (x) =>
          validateSpotifyPage(x, 'playlist items')
        )
      } catch (error) {
        // The playlist looked readable, but /items returned the S2 "not readable"
        // signal (403 or 404): access changed since the playlist was fetched.
        // Key on the error type, never on message text. Premium-required 403s
        // keep their own reason and pass through unchanged.
        if (
          error instanceof NotFoundError ||
          (error instanceof AccessRestrictedError && error.reason === 'other')
        ) {
          readable.set(id, false)
          throw new AccessRestrictedError(ACCESS_CHANGED_MESSAGE, 'not-owned')
        }
        throw error
      }

      const items: CanonicalTrack[] = mapSpotifyPlaylistItems(response.items, offset + 1)
        .filter((item) => item.track)
        .map((item) => item.track!)

      return { items, total: response.total, next: nextOffset(response, offset, limit) }
    },

    async getLikedTracks(page: PageRequest) {
      await guard('readLiked')

      // S3: GET /me/tracks accepts at most 50 per page
      const limit = Math.min(page.limit, LIKED_TRACKS_MAX_LIMIT)
      const offset = page.offset || 0
      const response = await getJson(`/me/tracks?limit=${limit}&offset=${offset}`, (x) =>
        validateSpotifyPage(x, 'saved tracks')
      )

      const items: CanonicalTrack[] = []
      response.items.forEach((raw, i) => {
        const saved = validateSpotifySavedTrack(raw, i)
        if (saved.track === null || saved.track === undefined) return
        const canonical = mapSpotifyTrackToCanonical(saved.track)
        // Preserve added_at from the liked tracks response
        if (saved.added_at !== undefined) canonical.addedAt = saved.added_at
        items.push(canonical)
      })

      return { items, total: response.total, next: nextOffset(response, offset, limit) }
    },
    async createPlaylist(input) {
      // Validation: collaborative + public is rejected by Spotify before API call (FR-PL-3)
      if (input.collaborative && input.public) {
        throw new UsageError(
          'Spotify does not support public collaborative playlists. Use either public or collaborative, not both.'
        )
      }

      // Scope check (M1-11)
      const token = await guard('createPlaylist', { public: input.public, collaborative: input.collaborative })

      const response = await http.requestJson(
        {
          method: 'POST',
          url: `${SPOTIFY_API_BASE}/me/playlists`,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: input.name,
            description: input.description,
            public: input.public,
            collaborative: input.collaborative ?? false,
          }),
        },
        validateObject('create playlist')
      )

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
      const id = playlistId(ref)

      // DELETE /me/library returns 200 with an empty body on success.
      const uri = `spotify:playlist:${id}`
      await http.request({
        method: 'DELETE',
        url: `${SPOTIFY_API_BASE}/me/library?uris=${encodeURIComponent(uri)}`,
      })

      return { action: 'unfollowed' }
    },
    async searchTracks(query, opts) {
      await guard('searchTracks')
      // ADR-0003 A2 "Spotify endpoints used": the adapter owns the query syntax.
      const q = query.kind === 'isrc' ? `isrc:${query.isrc}` : [query.title, query.artists[0]].filter(Boolean).join(' ')
      const limit = Math.min(opts.limit, SPOTIFY_CAPABILITIES.maxSearchPageSize)
      const params = new URLSearchParams({ q, type: 'track', limit: String(limit), offset: '0' })
      const response = await getJson(`/search?${params.toString()}`, validateSpotifySearchResponse)
      return mapSpotifySearchResults(response)
        .flatMap((item) => (item.type === 'track' ? [{ ref: item.ref, track: item.track }] : []))
        .slice(0, opts.limit)
    },
    async populatePlaylist(ref, trackRefs, opts) {
      await guard('populatePlaylist')
      const id = playlistId(ref)
      const added: string[] = []
      const failed: { ref: string; error: string }[] = []

      const existing = opts.skipExisting ? await playlistTrackUris(id) : new Set<string>()
      const toAdd: string[] = []
      for (const trackRef of trackRefs) {
        if (!SPOTIFY_TRACK_URI.test(trackRef)) failed.push({ ref: trackRef, error: 'Not a Spotify track URI' })
        else if (!existing.has(trackRef)) toAdd.push(trackRef)
      }

      // POST /playlists/{id}/items appends in request order, at most 100 per request.
      const batchSize = SPOTIFY_CAPABILITIES.maxTracksPerRequest
      for (let i = 0; i < toAdd.length; i += batchSize) {
        const uris = toAdd.slice(i, i + batchSize)
        try {
          await http.request({
            method: 'POST',
            url: `${SPOTIFY_API_BASE}/playlists/${id}/items`,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uris }),
          })
          added.push(...uris)
        } catch (error) {
          // Auth, quota and rate limits would fail every later batch too.
          if (isFatalProviderError(error)) throw error
          const message = error instanceof Error ? error.message : String(error)
          failed.push(...uris.map((u) => ({ ref: u, error: message })))
        }
      }

      return { added, failed }
    },
  }
}
