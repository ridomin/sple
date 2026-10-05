import type { PageRequest, Page } from './provider/provider.js'
import { UsageError } from './provider/errors.js'

export interface PaginateOptions {
  /** Size of each page request */
  pageSize: number
  /** Starting offset (for offset-based pagination only) */
  startOffset?: number
  /** Stop after collecting this many results */
  maxResults?: number
  /** Pagination model: 'offset' or 'cursor-forward' */
  model: 'offset' | 'cursor-forward'
}

export interface CollectAllOptions {
  /** Size of each page request */
  pageSize: number
  /** Maximum number of concurrent page requests (default 4) */
  concurrency?: number
  /** Stop after collecting this many results */
  maxResults?: number
}

/**
 * Create an async iterator for paginating through results.
 *
 * @param fetchPage - Function to fetch a page of results
 * @param options - Pagination options (pageSize, startOffset, maxResults, model)
 * @returns AsyncIterator<T> that yields individual items
 *
 * - For offset-based pagination, starts at startOffset (default 0)
 * - For cursor-forward pagination, rejects startOffset with UsageError
 * - Handles large pageSize by splitting across multiple requests if needed
 * - Stops at first short page (total shrunk)
 * - Respects maxResults exactly
 */
export async function* paginate<T>(
  fetchPage: (pageRequest: PageRequest) => Promise<Page<T>>,
  options: PaginateOptions
): AsyncIterator<T> {
  const { pageSize, startOffset = 0, maxResults, model } = options

  // Cursor-forward model rejects startOffset
  if (model === 'cursor-forward' && startOffset !== 0) {
    throw new UsageError('startOffset is not supported for cursor-forward pagination')
  }

  let yielded = 0
  let offset = startOffset
  let cursor: string | undefined

  while (true) {
    // Calculate how many items we still need
    const remaining = maxResults !== undefined ? maxResults - yielded : undefined

    // Stop if we've hit maxResults
    if (remaining !== undefined && remaining <= 0) {
      break
    }

    // Determine the limit for this request
    const limit = remaining !== undefined ? Math.min(pageSize, remaining) : pageSize

    // Make the request based on pagination model
    let page: Page<T>
    if (model === 'offset') {
      page = await fetchPage({ limit, offset })
    } else {
      page = await fetchPage({ limit, cursor })
    }

    // Stop if no items in this page (end of results)
    if (page.items.length === 0) {
      break
    }

    // Yield items
    for (const item of page.items) {
      if (remaining !== undefined && yielded >= maxResults!) {
        break
      }
      yield item
      yielded++
    }

    // Check if this page was short (end of results or total shrunk)
    if (page.items.length < limit) {
      break
    }

    // Prepare for next iteration
    if (model === 'offset') {
      offset += page.items.length
    } else {
      if (!page.next?.cursor) {
        break
      }
      cursor = page.next.cursor
    }

    // Stop if we've collected enough
    if (remaining !== undefined && yielded >= maxResults!) {
      break
    }
  }
}

/**
 * Collect all results from offset-based pagination with bounded concurrency.
 *
 * @param fetchPage - Function to fetch a page of results
 * @param options - Collection options (pageSize, concurrency, maxResults)
 * @returns Promise<T[]> with all results in order
 *
 * - First page is fetched sequentially (to get total count)
 * - Remaining pages are fetched with bounded concurrency (default 4)
 * - Order is preserved
 * - maxResults cap is exact (not rounded up)
 * - Stops at first short page if total changes
 */
export async function collectAll<T>(
  fetchPage: (pageRequest: PageRequest) => Promise<Page<T>>,
  options: CollectAllOptions
): Promise<T[]> {
  const { pageSize, concurrency = 4, maxResults } = options

  // Fetch the first page
  const firstPage = await fetchPage({ limit: pageSize, offset: 0 })
  const results = [...firstPage.items]

  // If first page is empty or we got what we need, return early
  if (firstPage.items.length === 0) {
    return results
  }

  if (maxResults !== undefined && results.length >= maxResults) {
    return results.slice(0, maxResults)
  }

  // Determine total number of items
  const total = firstPage.total ?? firstPage.items.length

  // Calculate how many more pages we need
  let pagesToFetch = Math.ceil((total - pageSize) / pageSize)

  // Respect maxResults
  if (maxResults !== undefined) {
    const needed = maxResults - results.length
    pagesToFetch = Math.ceil(needed / pageSize)
  }

  if (pagesToFetch <= 0) {
    return maxResults ? results.slice(0, maxResults) : results
  }

  // Fetch remaining pages with bounded concurrency
  const pages: (T[] | null)[] = []

  for (let i = 0; i < pagesToFetch; i += concurrency) {
    const batch = []
    const batchEnd = Math.min(i + concurrency, pagesToFetch)

    for (let j = i; j < batchEnd; j++) {
      const offset = pageSize + j * pageSize
      batch.push(
        fetchPage({ limit: pageSize, offset })
          .then(page => {
            // Check if this page is short (total shrunk)
            if (page.items.length < pageSize) {
              return page.items
            }
            return page.items
          })
          .catch(err => {
            // Re-throw errors
            throw err
          })
      )
    }

    const batchResults = await Promise.all(batch)

    for (let k = 0; k < batchResults.length; k++) {
      const pageItems = batchResults[k]
      pages.push(pageItems)

      // Check if we got a short page (total shrunk or end of results)
      if (pageItems.length < pageSize) {
        // Stop fetching more pages
        pagesToFetch = pages.length
        i = pagesToFetch
        break
      }
    }

    // Add items to results
    for (const pageItems of batchResults) {
      if (pageItems) {
        results.push(...pageItems)

        // Check if we've collected enough
        if (maxResults !== undefined && results.length >= maxResults) {
          return results.slice(0, maxResults)
        }
      }
    }
  }

  // Return results, respecting maxResults if set
  return maxResults ? results.slice(0, maxResults) : results
}

export interface PageProgress {
  /** Pages fetched so far */
  pages: number
  /** Total pages, when the provider reported a total on the first page */
  totalPages?: number
  /** Items collected so far */
  items: number
  /** Total items reported by the provider on the first page */
  total?: number
}

export interface CollectPagesOptions {
  /** Size of each page request (must not exceed the provider's per-request cap) */
  pageSize: number
  /** Maximum concurrent page requests once the total is known (default 4) */
  concurrency?: number
  /** Pagination model of the provider (default 'offset') */
  model?: 'offset' | 'cursor-forward'
  /** Called after every fetched page */
  onPage?: (progress: PageProgress) => void
}

/**
 * Read every page of a paginated provider endpoint, preserving order.
 *
 * - The first page is fetched alone. If the provider is offset-paginated and
 *   reports `total`, the remaining offsets (`pageSize`, `2 * pageSize`, …) are
 *   fetched with bounded concurrency.
 * - Otherwise (no `total`, or cursor pagination) pages are read one after the
 *   other by following `next`.
 * - Offsets advance by `pageSize`, not by the number of items returned, so a
 *   provider that drops items from a page (unsupported items, client-side
 *   filters) does not shift later pages.
 *
 * Returns the items plus the `total` the provider reported on the first page.
 */
export async function collectPages<T>(
  fetchPage: (pageRequest: PageRequest) => Promise<Page<T>>,
  options: CollectPagesOptions
): Promise<{ items: T[]; total?: number }> {
  const { pageSize, concurrency = 4, model = 'offset', onPage } = options
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new UsageError('pageSize must be a positive integer')
  }

  const first = await fetchPage(model === 'offset' ? { limit: pageSize, offset: 0 } : { limit: pageSize })
  const items: T[] = [...first.items]
  const total = first.total
  const totalPages =
    model === 'offset' && total !== undefined ? Math.max(1, Math.ceil(total / pageSize)) : undefined
  let pages = 1
  onPage?.({ pages, totalPages, items: items.length, total })

  let next = first.next

  if (model === 'offset' && total !== undefined && next) {
    const offsets: number[] = []
    for (let offset = pageSize; offset < total; offset += pageSize) offsets.push(offset)

    let last: Page<T> | undefined
    for (let i = 0; i < offsets.length; i += Math.max(1, concurrency)) {
      const batch = offsets.slice(i, i + Math.max(1, concurrency))
      const results = await Promise.all(batch.map((offset) => fetchPage({ limit: pageSize, offset })))
      for (const page of results) {
        items.push(...page.items)
        pages++
        onPage?.({ pages, totalPages, items: items.length, total })
        last = page
      }
    }
    // If the collection grew while reading, keep following `next` from the last page.
    next = last ? last.next : undefined
  }

  while (next && (next.offset !== undefined || next.cursor !== undefined)) {
    const page = await fetchPage({ limit: pageSize, ...next })
    items.push(...page.items)
    pages++
    onPage?.({ pages, totalPages, items: items.length, total })
    next = page.next
  }

  return { items, total }
}
