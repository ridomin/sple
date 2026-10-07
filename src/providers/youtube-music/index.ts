import type { Provider, PageRequest } from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import { HttpClient } from '../../core/http/client.js'
import { YouTubeMusicAuth } from './auth.js'
import { YouTubeMusicHttpClient } from './client.js'
import { parseYouTubePlaylistId } from './playlist-ref.js'

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
  const auth = new YouTubeMusicAuth(clientId, clientSecret, configDir)

  const http = new HttpClient({
    providerId: 'youtube-music',
    getToken: () => auth.getToken(),
    refresh: (token) => auth.refresh(token),
    onResponse: undefined,
  })

  const client = new YouTubeMusicHttpClient(http)

  return {
    id: 'youtube-music',
    displayName: 'YouTube Music',
    capabilities: YOUTUBE_MUSIC_CAPABILITIES,
    auth,

    parsePlaylistRef: parseYouTubePlaylistId,

    async search(q, page: PageRequest) {
      await auth.requireScopes(['https://www.googleapis.com/auth/youtube'])
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
      await auth.requireScopes(['https://www.googleapis.com/auth/youtube'])
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
      await auth.requireScopes(['https://www.googleapis.com/auth/youtube'])
      return await client.getPlaylist(ref)
    },

    async getPlaylistTracks(ref: string, page: PageRequest) {
      await auth.requireScopes(['https://www.googleapis.com/auth/youtube'])
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
      await auth.requireScopes(['https://www.googleapis.com/auth/youtube'])
      // YouTube API doesn't expose liked songs directly; return empty for now
      // TODO: Implement via favorites or watch history (M4a spike S5)
      return { items: [] }
    },

    async createPlaylist(input) {
      await auth.requireScopes(['https://www.googleapis.com/auth/youtube'])
      return await client.createPlaylist({
        name: input.name,
        description: input.description,
        public: input.public ?? true,
      })
    },

    async removePlaylist(ref: string) {
      await auth.requireScopes(['https://www.googleapis.com/auth/youtube'])
      return await client.removePlaylist(ref)
    },

    async searchTracks(query, opts) {
      // isrcSearchMode is 'none': the engine never sends an ISRC query here.
      if (query.kind === 'isrc') return []
      await auth.requireScopes(['https://www.googleapis.com/auth/youtube'])
      const { items } = await client.searchTracks(
        { text: [query.title, ...query.artists].join(' ') },
        { limit: opts.limit }
      )
      return items.slice(0, opts.limit).map(track => ({ ref: track.refs['youtube-music'], track }))
    },

    async populatePlaylist(ref: string, trackRefs: string[], opts) {
      await auth.requireScopes(['https://www.googleapis.com/auth/youtube'])
      return await client.populatePlaylist(ref, trackRefs, opts)
    },
  }
}
