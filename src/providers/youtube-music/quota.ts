import type { QuotaModel } from '../../core/provider/capabilities.js'
import type { HttpRequest } from '../../core/http/client.js'

const PT = 'America/Los_Angeles'

/** ADR 0002 §4.1 (minus `writeLiked`): default Data API quota for one Google Cloud project. */
export const YOUTUBE_QUOTA_MODEL: QuotaModel = {
  kind: 'daily-buckets',
  buckets: [
    { id: 'units', dailyLimit: 10_000, resetTimeZone: PT },
    { id: 'search', dailyLimit: 100, resetTimeZone: PT },
  ],
  costs: {
    search: [{ bucket: 'search', amount: 1, per: 'call' }],
    searchTracks: [
      { bucket: 'search', amount: 1, per: 'call' },
      { bucket: 'units', amount: 1, per: 'call' },
    ],
    listPlaylists: [{ bucket: 'units', amount: 1, per: 'page', pageSize: 50 }],
    getPlaylistItems: [{ bucket: 'units', amount: 1, per: 'page', pageSize: 50 }],
    createPlaylist: [{ bucket: 'units', amount: 50, per: 'call' }],
    removePlaylist: [{ bucket: 'units', amount: 50, per: 'call' }],
    populatePlaylist: [{ bucket: 'units', amount: 50, per: 'item' }],
    readLiked: [{ bucket: 'units', amount: 1, per: 'page', pageSize: 50 }],
  },
}

/**
 * Quota charged for one Data API request: `search.list` takes 1 from its own
 * bucket; any other read 1 unit; inserts, updates and deletes 50 units.
 */
export function youTubeRequestCost(req: Pick<HttpRequest, 'method' | 'url'>): { bucket: 'units' | 'search'; amount: number } {
  const method = req.method.toUpperCase()
  if (method !== 'GET') return { bucket: 'units', amount: 50 }
  return new URL(req.url).pathname.endsWith('/search') ? { bucket: 'search', amount: 1 } : { bucket: 'units', amount: 1 }
}
