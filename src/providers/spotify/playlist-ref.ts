const ID = '[A-Za-z0-9]{22}'
const BARE_ID = new RegExp(`^${ID}$`)
const URI = new RegExp(`^spotify:playlist:(${ID})$`)
const URL_PATH = new RegExp(`^/(?:intl-[A-Za-z-]+/)?playlist/(${ID})/?$`)

/**
 * Parse a Spotify playlist reference. Accepts:
 * - a bare 22-char base62 ID
 * - `spotify:playlist:<id>`
 * - `https://open.spotify.com/[intl-xx/]playlist/<id>[?…][#…]`
 *
 * Returns the 22-char playlist ID, or null when the input is not one of these
 * forms (the caller then falls back to name lookup). An ID-shaped input is
 * always treated as an ID. Pure; no I/O.
 */
export function parseSpotifyPlaylistRef(input: string): string | null {
  const s = input.trim()
  if (BARE_ID.test(s)) return s

  const uri = URI.exec(s)
  if (uri) return uri[1]

  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname !== 'open.spotify.com') return null
  const m = URL_PATH.exec(url.pathname)
  return m ? m[1] : null
}
