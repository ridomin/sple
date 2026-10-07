import type { Provider, PageRequest } from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import { HttpClient } from '../../core/http/client.js'
import { YouTubeMusicAuth } from './auth.js'
import { YouTubeMusicHttpClient } from './client.js'
import { mapYouTubeHttpError } from './errors.js'
import { parseYouTubePlaylistId, parseYouTubeTrackRef } from './playlist-ref.js'
import { YOUTUBE_QUOTA_MODEL, youTubeRequestCost } from './quota.js'
import { QuotaLedger } from '../../core/quota/ledger.js'
import { QuotaExhaustedError } from '../../core/provider/errors.js'

const YOUTUBE_MUSIC_CAPABILITIES: ProviderCapabilities = {
  official: true,
  requiresRiskAcknowledgement: false,
  userSuppliedClientId: true,
  requiresClientSecret: true,
  supportsRefreshToken: true,
  supportsRevocation: true,
  paginationModel: 'cursor-forward',
  maxSearchPageSize: 50,
  readPageSize: { playlists: 50, playlistItems: 50, liked: 50 },
  playlistItemsAccess: 'all',
  likedSongs: { read: 'approximate', write: false, readCap: 5000 },
  isrcSearchMode: 'none',
  searchReturnsDuration: false,
  musicAwareSearch: false,
  canDeletePlaylist: true,
  supportsCollaborative: false,
  maxTracksPerRequest: 1,
  quotaModel: YOUTUBE_QUOTA_MODEL,
}

export function createYouTubeMusicProvider(
  clientId: string,
  clientSecret: string,
  configDir?: string
): Provider {
  const auth = new YouTubeMusicAuth(clientId, clientSecret, configDir)

  const ledger = new QuotaLedger(
    'youtube-music',
    YOUTUBE_QUOTA_MODEL.kind === 'daily-buckets' ? YOUTUBE_QUOTA_MODEL.buckets : [],
    { configDir }
  )

  const http = new HttpClient({
    providerId: 'youtube-music',
    getToken: () => auth.getToken(),
    refresh: (token) => auth.refresh(token),
    // Charged before every attempt: failed calls cost quota too.
    beforeAttempt: (req) => {
      const cost = youTubeRequestCost(req)
      ledger.charge(cost.bucket, cost.amount)
    },
    mapError: (res, req) => {
      const error = mapYouTubeHttpError(res)
      // YouTube says the quota is gone: stop charging calls that would fail until the reset.
      if (error instanceof QuotaExhaustedError && req) ledger.markExhausted(youTubeRequestCost(req).bucket)
      return error
    },
  })

  const client = new YouTubeMusicHttpClient(http)

  return {
    id: 'youtube-music',
    displayName: 'YouTube Music',
    capabilities: YOUTUBE_MUSIC_CAPABILITIES,
    auth,

    parsePlaylistRef: parseYouTubePlaylistId,
    parseTrackRef: parseYouTubeTrackRef,

    async search(q, page: PageRequest) {
      await auth.requireOperation('search')
      const { items: tracks, nextPageToken, totalResults } = await client.searchTracks(
        { text: q.text },
        { limit: page.limit, cursor: page.cursor as string | undefined }
      )

      // Convert CanonicalTrack to SearchItem
      const items = tracks.map((track, idx) => ({
        id: track.refs?.['youtube-music'] || `yt-${idx}`,
        ref: track.refs?.['youtube-music'] || '',
        name: track.title,
        type: 'track' as const,
        track
      }))

      return {
        items,
        total: totalResults,
        next: nextPageToken ? { cursor: nextPageToken } : undefined
      }
    },

    async listPlaylists(page: PageRequest) {
      await auth.requireOperation('listPlaylists')
      const { items: playlists, nextPageToken, totalResults } = await client.listPlaylists({
        limit: page.limit,
        cursor: page.cursor as string | undefined
      })
      return {
        items: playlists,
        total: totalResults,
        next: nextPageToken ? { cursor: nextPageToken } : undefined
      }
    },

    async getPlaylist(ref: string) {
      await auth.requireOperation('getPlaylist')
      return await client.getPlaylist(ref)
    },

    async getPlaylistTracks(ref: string, page: PageRequest) {
      await auth.requireOperation('getPlaylistTracks')
      const { items, nextPageToken, totalResults } = await client.getPlaylistTracks(
        ref,
        { limit: page.limit, cursor: page.cursor as string | undefined }
      )
      return {
        items,
        total: totalResults,
        next: nextPageToken ? { cursor: nextPageToken } : undefined
      }
    },

    async getLikedTracks(_page: PageRequest) {
      await auth.requireOperation('getLikedTracks')
      // YouTube API doesn't expose liked songs directly; return empty for now
      // TODO: Implement via favorites or watch history (M4a spike S5)
      return { items: [] }
    },

    async createPlaylist(input) {
      await auth.requireOperation('createPlaylist')
      return await client.createPlaylist({
        name: input.name,
        description: input.description,
        public: input.public ?? true,
      })
    },

    async removePlaylist(ref: string) {
      await auth.requireOperation('removePlaylist')
      return await client.removePlaylist(ref)
    },

    async searchTracks(query, opts) {
      // isrcSearchMode is 'none': the engine never sends an ISRC query here.
      if (query.kind === 'isrc') return []
      await auth.requireOperation('searchTracks')
      const { items } = await client.searchTracks(
        { text: [query.title, ...query.artists].join(' ') },
        { limit: opts.limit },
        { musicOnly: true }
      )
      return items.slice(0, opts.limit).map(track => ({ ref: track.refs['youtube-music'], track }))
    },

    async populatePlaylist(ref: string, trackRefs: string[], opts) {
      await auth.requireOperation('populatePlaylist')
      return await client.populatePlaylist(ref, trackRefs, opts)
    },
  }
}
