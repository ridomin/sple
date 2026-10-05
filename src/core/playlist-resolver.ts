import type { Provider, PlaylistSummary, PageRequest } from './provider/provider.js'
import { NotFoundError, UsageError } from './provider/errors.js'

/**
 * Cache for listPlaylists results. Shared across all invocations in the
 * process (not per request). Invalidation is the caller's responsibility
 * (restart process if list changes).
 *
 * For testing, use clearPlaylistCache() to reset.
 */
const playlistListCache = new Map<string, PlaylistSummary[]>()

/**
 * Clear the playlist cache. Exposed for testing purposes.
 */
export function clearPlaylistCache(): void {
  playlistListCache.clear()
}

/**
 * Fetch all playlists from the provider, returning a cached result if available.
 * Cache key is the provider ID.
 */
async function getAllPlaylists(provider: Provider): Promise<PlaylistSummary[]> {
  const cacheKey = provider.id
  if (playlistListCache.has(cacheKey)) {
    return playlistListCache.get(cacheKey)!
  }

  const allPlaylists: PlaylistSummary[] = []
  let cursor: PageRequest = { limit: 50 }

  // Fetch all pages
  while (true) {
    const page = await provider.listPlaylists(cursor)
    allPlaylists.push(...page.items)

    if (!page.next) break
    cursor = { limit: 50, ...page.next }
  }

  // Cache the result
  playlistListCache.set(cacheKey, allPlaylists)
  return allPlaylists
}

/**
 * Resolve a user input (ID, URI, URL, or name) to a playlist ref.
 *
 * Algorithm:
 * 1. Parse ref: call provider.parsePlaylistRef(input)
 *    - If returns a ref: fetch and return the playlist
 * 2. Exact name match:
 *    - Case-sensitive first
 *    - Then case-insensitive
 *    - Search across listPlaylists() (all pages, cached per process)
 * 3. Not found: throw NotFoundError (exit 4)
 * 4. Ambiguous (>1 match): throw UsageError (exit 2) listing each match
 */
export async function resolvePlaylist(provider: Provider, input: string): Promise<PlaylistSummary> {
  // Step 1: Try to parse as a ref (ID, URI, or URL)
  const parsedRef = provider.parsePlaylistRef(input)
  if (parsedRef !== null) {
    const playlist = await provider.getPlaylist(parsedRef)
    return playlist
  }

  // Step 2: Try exact name match (case-sensitive, then case-insensitive)
  const allPlaylists = await getAllPlaylists(provider)

  // Case-sensitive match
  const caseSensitiveMatches = allPlaylists.filter((p) => p.name === input)
  if (caseSensitiveMatches.length === 1) {
    return caseSensitiveMatches[0]
  }
  if (caseSensitiveMatches.length > 1) {
    throw formatAmbiguousError(input, caseSensitiveMatches)
  }

  // Case-insensitive match
  const inputLower = input.toLowerCase()
  const caseInsensitiveMatches = allPlaylists.filter((p) => p.name.toLowerCase() === inputLower)
  if (caseInsensitiveMatches.length === 1) {
    return caseInsensitiveMatches[0]
  }
  if (caseInsensitiveMatches.length > 1) {
    throw formatAmbiguousError(input, caseInsensitiveMatches)
  }

  // Step 3: Not found
  throw new NotFoundError(`Playlist "${input}" not found`, 'playlist')
}

/**
 * Format an ambiguous match error with all matches listed.
 */
function formatAmbiguousError(input: string, matches: PlaylistSummary[]): UsageError {
  const lines = [
    `Multiple playlists matched "${input}":`,
    ...matches.map((p) => {
      const owned = p.owned ? ' (owned)' : ''
      const ownerDisplay = p.owner.displayName || p.owner.id
      return `  • ${p.name} (id: ${p.id}, owner: ${ownerDisplay}${owned})`
    }),
    'Specify the playlist ID to disambiguate.',
  ]
  return new UsageError(lines.join('\n'))
}
