import type { Provider, SearchItem, SearchType, Page } from './provider/provider.js'
import { UsageError } from './provider/errors.js'
import { paginate } from './pagination.js'

/** Default number of results for a search without `--limit` or `--all`. */
export const DEFAULT_SEARCH_LIMIT = 10

/** Default safety cap (in results, not pages) for `--all` (FR-SEARCH-2). */
export const DEFAULT_SEARCH_ALL_CAP = 100

/**
 * Hard ceiling for search pagination. Spotify caps search at
 * `limit + offset <= 1000` (spike S3), so no search can read past result 1000.
 */
export const SEARCH_MAX_RESULTS_CEILING = 1000

export interface SearchOptions {
  /** Number of results to return (non-`--all` mode). Default 10. */
  limit?: number
  /** Starting offset (non-`--all` mode). Default 0. */
  offset?: number
  /** Read until results run out or the cap is reached. */
  all?: boolean
  /** Cap for `--all`. Default 100, must be <= SEARCH_MAX_RESULTS_CEILING. */
  maxResults?: number
}

function assertPositiveInt(value: number, flag: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`${flag} must be a positive integer`)
  }
}

/**
 * Validate the search options and compute where to start and how many results to read.
 * Throws UsageError (exit 2) for invalid combinations.
 */
export function resolveSearchWindow(
  provider: Provider,
  opts: SearchOptions
): { startOffset: number; maxResults: number } {
  if (opts.all) {
    if (opts.offset !== undefined) {
      throw new UsageError('--offset cannot be used with --all')
    }
    if (opts.limit !== undefined) {
      throw new UsageError('--limit cannot be used with --all; use --max-results to set the cap')
    }
    const maxResults = opts.maxResults ?? DEFAULT_SEARCH_ALL_CAP
    assertPositiveInt(maxResults, '--max-results')
    if (maxResults > SEARCH_MAX_RESULTS_CEILING) {
      throw new UsageError(
        `--max-results cannot exceed ${SEARCH_MAX_RESULTS_CEILING} (provider search ceiling)`
      )
    }
    return { startOffset: 0, maxResults }
  }

  if (opts.maxResults !== undefined) {
    throw new UsageError('--max-results can only be used with --all')
  }

  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT
  assertPositiveInt(limit, '--limit')
  const startOffset = opts.offset ?? 0
  if (!Number.isInteger(startOffset) || startOffset < 0) {
    throw new UsageError('--offset must be a non-negative integer')
  }
  if (startOffset > 0 && provider.capabilities.paginationModel !== 'offset') {
    throw new UsageError(`--offset is not supported by ${provider.displayName}`)
  }
  if (startOffset + limit > SEARCH_MAX_RESULTS_CEILING) {
    throw new UsageError(
      `--offset + --limit cannot exceed ${SEARCH_MAX_RESULTS_CEILING} (provider search ceiling)`
    )
  }
  return { startOffset, maxResults: limit }
}

/**
 * Run a search, splitting the request into pages of `maxSearchPageSize`
 * via the shared `paginate()` helper (M1-13).
 *
 * `--limit 25` on Spotify (page size 10) makes three requests: 10, 10, 5.
 */
export async function searchAll(
  provider: Provider,
  q: { text: string; type: SearchType },
  opts: SearchOptions = {}
): Promise<Page<SearchItem>> {
  const { startOffset, maxResults } = resolveSearchWindow(provider, opts)
  const pageSize = provider.capabilities.maxSearchPageSize
  const model = provider.capabilities.paginationModel === 'offset' ? 'offset' : 'cursor-forward'

  let lastPage: Page<SearchItem> | undefined
  const iterator = paginate<SearchItem>(
    async (req) => {
      lastPage = await provider.search(q, req)
      return lastPage
    },
    { pageSize, startOffset, maxResults, model }
  )

  const items: SearchItem[] = []
  while (true) {
    const r = await iterator.next()
    if (r.done) break
    items.push(r.value)
  }

  const result: Page<SearchItem> = { items }
  if (lastPage?.total !== undefined) result.total = lastPage.total
  // Offer a continuation only when the provider reports more results and we stopped at the cap.
  if (model === 'offset' && lastPage?.next && items.length === maxResults) {
    const nextOffset = startOffset + items.length
    if (nextOffset < SEARCH_MAX_RESULTS_CEILING) result.next = { offset: nextOffset }
  }
  return result
}
