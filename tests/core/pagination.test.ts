import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginate, collectAll } from '../../src/core/pagination.js'
import { UsageError } from '../../src/core/provider/errors.js'
import type { Page, PageRequest } from '../../src/core/provider/provider.js'

test('paginate', async (t) => {
  await t.test('works as async iterator with offset model', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: i }))
    let pageNumber = 0

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      const offset = req.offset ?? 0
      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)
      pageNumber++
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    const collected: typeof items = []
    for await (const item of paginate(fetchPage, { pageSize: 10, model: 'offset' })) {
      collected.push(item)
    }

    assert.equal(collected.length, 25)
    assert.deepEqual(collected, items)
    assert.equal(pageNumber, 3) // 10 + 10 + 5
  })

  await t.test('respects maxResults exactly', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: i }))

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      const offset = req.offset ?? 0
      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    const collected: typeof items = []
    for await (const item of paginate(fetchPage, { pageSize: 10, model: 'offset', maxResults: 25 })) {
      collected.push(item)
    }

    assert.equal(collected.length, 25)
    assert.deepEqual(collected, items.slice(0, 25))
  })

  await t.test('rejects startOffset with UsageError for cursor-forward model', async () => {
    async function fetchPage(_req: PageRequest): Promise<Page<{ id: number }>> {
      return { items: [] }
    }

    const iterator = paginate(fetchPage, {
      pageSize: 10,
      startOffset: 5,
      model: 'cursor-forward',
    })

    try {
      await iterator.next()
      assert.fail('Should have thrown UsageError')
    } catch (err) {
      assert.ok(err instanceof UsageError)
      assert.ok(err.message.includes('startOffset'))
    }
  })

  await t.test('cursor-forward model works without startOffset', async () => {
    const page1Items = [{ id: 1 }, { id: 2 }]
    const page2Items = [{ id: 3 }, { id: 4 }]

    async function fetchPage(req: PageRequest): Promise<Page<{ id: number }>> {
      if (!req.cursor) {
        return {
          items: page1Items,
          next: { cursor: 'cursor-page2' },
        }
      }
      if (req.cursor === 'cursor-page2') {
        return {
          items: page2Items,
        }
      }
      return { items: [] }
    }

    const collected: typeof page1Items = []
    for await (const item of paginate(fetchPage, { pageSize: 2, model: 'cursor-forward' })) {
      collected.push(item)
    }

    assert.deepEqual(collected, [...page1Items, ...page2Items])
  })

  await t.test('stops at first short page', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: i }))
    let requestCount = 0

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      requestCount++
      const offset = req.offset ?? 0
      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    const collected: typeof items = []
    for await (const item of paginate(fetchPage, { pageSize: 10, model: 'offset' })) {
      collected.push(item)
    }

    assert.equal(collected.length, 25)
    assert.equal(requestCount, 3) // 10 + 10 + 5 (stops at short page)
  })

  await t.test('uses startOffset correctly', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: i }))
    const receivedOffsets: number[] = []

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      const offset = req.offset ?? 0
      receivedOffsets.push(offset)
      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    const collected: typeof items = []
    for await (const item of paginate(fetchPage, { pageSize: 10, startOffset: 10, model: 'offset' })) {
      collected.push(item)
    }

    assert.deepEqual(receivedOffsets, [10, 20, 30])
    assert.deepEqual(collected, items.slice(10))
  })
})

test('collectAll', async (t) => {
  await t.test('fetches all items with offset pagination', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i }))

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      const offset = req.offset ?? 0
      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    const collected = await collectAll(fetchPage, { pageSize: 10 })
    assert.equal(collected.length, 50)
    assert.deepEqual(collected, items)
  })

  await t.test('preserves order under concurrency', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }))
    const requestOrder: number[] = []
    let requestCount = 0

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      const offset = req.offset ?? 0
      const requestNumber = requestCount++
      requestOrder.push(requestNumber)

      // Simulate varying latencies
      const delay = Math.random() * 50
      await new Promise(resolve => setTimeout(resolve, delay))

      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    const collected = await collectAll(fetchPage, { pageSize: 10, concurrency: 4 })

    assert.equal(collected.length, 100)
    // Verify order is preserved
    for (let i = 0; i < collected.length; i++) {
      assert.equal(collected[i].id, i)
    }
  })

  await t.test('respects maxResults exactly', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }))

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      const offset = req.offset ?? 0
      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    const collected = await collectAll(fetchPage, { pageSize: 10, maxResults: 25 })
    assert.equal(collected.length, 25)
    assert.deepEqual(collected, items.slice(0, 25))
  })

  await t.test('stops at first short page', async () => {
    const items = Array.from({ length: 35 }, (_, i) => ({ id: i }))
    let requestCount = 0

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      requestCount++
      const offset = req.offset ?? 0
      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    const collected = await collectAll(fetchPage, { pageSize: 10 })
    assert.equal(collected.length, 35)
    assert.equal(requestCount, 4) // 10 + 10 + 10 + 5 (stops at short page)
  })

  await t.test('uses default concurrency of 4', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }))
    const concurrentRequests: number[] = []
    let activeRequests = 0
    let maxConcurrent = 0

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      activeRequests++
      maxConcurrent = Math.max(maxConcurrent, activeRequests)

      await new Promise(resolve => setTimeout(resolve, 10))

      const offset = req.offset ?? 0
      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)

      activeRequests--
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    await collectAll(fetchPage, { pageSize: 10 })
    // Allow some variance due to timing
    assert.ok(maxConcurrent >= 2 && maxConcurrent <= 5)
  })

  await t.test('returns empty for no items', async () => {
    async function fetchPage(_req: PageRequest): Promise<Page<{ id: number }>> {
      return { items: [], total: 0 }
    }

    const collected = await collectAll(fetchPage, { pageSize: 10 })
    assert.deepEqual(collected, [])
  })

  await t.test('handles single page correctly', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i }))

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      const offset = req.offset ?? 0
      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    const collected = await collectAll(fetchPage, { pageSize: 10 })
    assert.deepEqual(collected, items)
  })

  await t.test('respects custom concurrency', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }))
    let maxConcurrent = 0
    let activeRequests = 0

    async function fetchPage(req: PageRequest): Promise<Page<typeof items[0]>> {
      activeRequests++
      maxConcurrent = Math.max(maxConcurrent, activeRequests)

      await new Promise(resolve => setTimeout(resolve, 5))

      const offset = req.offset ?? 0
      const limit = req.limit
      const start = offset
      const end = Math.min(offset + limit, items.length)

      activeRequests--
      return {
        items: items.slice(start, end),
        total: items.length,
      }
    }

    await collectAll(fetchPage, { pageSize: 10, concurrency: 2 })
    assert.ok(maxConcurrent <= 3) // Allow small variance
  })
})
