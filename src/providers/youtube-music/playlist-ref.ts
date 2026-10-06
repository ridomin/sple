// Playlist IDs from the API vary in length (13 chars observed, 34 typical)
const BARE_ID = /^[A-Za-z0-9_-]{13,}$/
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])

/**
 * Parse a YouTube playlist reference. Accepts:
 * - a bare playlist ID (≥ 13 chars of [A-Za-z0-9_-])
 * - `https://{www.,m.,music.,}youtube.com/<path>?list=<id>[&…]`, where <id>
 *   passes the same check as a bare ID (so the client accepts every result)
 *
 * Returns the playlist ID, or null when the input is not one of these forms
 * (the caller then falls back to name lookup). A single-word name can look
 * like an ID, so the resolver also falls back to name lookup when the ID is
 * not found. Pure; no I/O.
 */
export function parseYouTubePlaylistId(input: string): string | null {
  const s = input.trim()
  if (BARE_ID.test(s)) return s

  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!HOSTS.has(url.hostname)) return null
  const list = url.searchParams.get('list')
  return list && BARE_ID.test(list) ? list : null
}
