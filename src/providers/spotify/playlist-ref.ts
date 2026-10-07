const ID = '[A-Za-z0-9]{22}'
const BARE_ID = new RegExp(`^${ID}$`)
const URI = new RegExp(`^spotify:playlist:(${ID})$`)
const URL_PATH = new RegExp(`^/(?:intl-[A-Za-z-]+/)?playlist/(${ID})/?$`)
const TRACK_URI = new RegExp(`^spotify:track:(${ID})$`)
const TRACK_URL_PATH = new RegExp(`^/(?:intl-[A-Za-z-]+/)?track/(${ID})/?$`)

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

/**
 * Parse a Spotify track reference (ADR-0003 §3.1). Accepts a bare 22-char ID,
 * `spotify:track:<id>`, or `http(s)://open.spotify.com/[intl-xx/]track/<id>[/][?…][#…]`.
 * Returns the canonical `spotify:track:<id>`, or null. Pure; no I/O.
 */
export function parseSpotifyTrackRef(input: string): string | null {
  const s = input.trim()
  const id = BARE_ID.test(s) ? s : (TRACK_URI.exec(s)?.[1] ?? trackIdFromUrl(s))
  return id ? `spotify:track:${id}` : null
}

function trackIdFromUrl(s: string): string | null {
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname !== 'open.spotify.com') return null
  return TRACK_URL_PATH.exec(url.pathname)?.[1] ?? null
}
