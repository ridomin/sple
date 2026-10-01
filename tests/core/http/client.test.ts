import { test } from 'node:test'
import * as assert from 'node:assert'
import { HttpClient } from '../../../src/core/http/client.js'
import type { StoredToken } from '../../../src/core/config/token-store.js'

// Mock fetch
let mockFetchResponse: Response | Error | null = null
let mockFetchCallCount = 0
const mockFetchCalls: Array<{
  url: string
  method: string
  headers?: Record<string, string>
}> = []

const originalFetch = globalThis.fetch
const mockFetch = async (url: string, init?: RequestInit) => {
  mockFetchCallCount++
  mockFetchCalls.push({
    url: String(url),
    method: init?.method || 'GET',
    headers: init?.headers as Record<string, string>,
  })

  if (mockFetchResponse instanceof Error) {
    throw mockFetchResponse
  }
  return mockFetchResponse!
}

test('HTTP client', async (t) => {
  await t.before(() => {
    globalThis.fetch = mockFetch as any
  })

  await t.after(() => {
    globalThis.fetch = originalFetch
  })

  await t.test('successful request', async () => {
    mockFetchCallCount = 0
    mockFetchCalls.length = 0
    mockFetchResponse = new Response('{"user": "test"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

    const client = new HttpClient({
      providerId: 'spotify',
    })

    const response = await client.request({
      method: 'GET',
      url: 'https://api.spotify.com/v1/me',
      headers: { Authorization: 'Bearer token123' },
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.body, '{"user": "test"}')
    assert.strictEqual(mockFetchCallCount, 1)
  })

  await t.test('retries on 5xx error', async () => {
    mockFetchCallCount = 0
    mockFetchCalls.length = 0
    let callCount = 0

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      callCount++
      mockFetchCalls.push({
        url: String(url),
        method: init?.method || 'GET',
      })

      if (callCount < 3) {
        return new Response('Service Unavailable', { status: 503 })
      }
      return new Response('OK', { status: 200 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      maxRetries: 3,
    })

    const response = await client.request({
      method: 'GET',
      url: 'https://api.spotify.com/v1/me',
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(callCount, 3)
  })

  await t.test('respects Retry-After header (seconds)', async () => {
    mockFetchCallCount = 0
    mockFetchCalls.length = 0
    let callCount = 0
    const timings: number[] = []

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      callCount++
      timings.push(Date.now())

      if (callCount === 1) {
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'retry-after': '1' }, // 1 second
        })
      }
      return new Response('OK', { status: 200 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
    })

    const response = await client.request({
      method: 'GET',
      url: 'https://api.spotify.com/v1/me',
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(callCount, 2)
    // Should have waited roughly 1 second (allow 200ms variance)
    const waited = timings[1] - timings[0]
    assert.ok(waited >= 800 && waited <= 1200, `Wait time was ${waited}ms`)
  })

  await t.test('handles 401 with token refresh', async () => {
    mockFetchCallCount = 0
    mockFetchCalls.length = 0
    let callCount = 0
    const newToken: StoredToken = {
      accessToken: 'new_token_456',
      refreshToken: 'refresh_789',
      scopes: ['playlist-read'],
      userId: 'user123',
      grantedAt: '2026-10-01T00:00:00Z',
    }

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      callCount++
      const headers = init?.headers as Record<string, string>

      // First request: 401
      if (callCount === 1) {
        return new Response('Unauthorized', { status: 401 })
      }

      // After refresh: should have new token
      if (headers?.Authorization === 'Bearer new_token_456') {
        return new Response('{"user": "test"}', { status: 200 })
      }

      return new Response('Forbidden', { status: 403 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      onRefreshToken: async (token) => ({ ...token, accessToken: 'new_token_456' }),
    })

    const response = await client.request({
      method: 'GET',
      url: 'https://api.spotify.com/v1/me',
      headers: { Authorization: 'Bearer old_token_123' },
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(callCount, 2) // Original request + retry with new token
  })

  await t.test('handles 401 without refresh handler', async () => {
    globalThis.fetch = (async () => {
      return new Response('Unauthorized', { status: 401 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      // No onRefreshToken handler
    })

    await assert.rejects(
      () =>
        client.request({
          method: 'GET',
          url: 'https://api.spotify.com/v1/me',
        }),
      (error: any) => error.name === 'AuthRequiredError'
    )
  })

  await t.test('throws RateLimitError on repeated 429', async () => {
    globalThis.fetch = (async () => {
      return new Response('Too Many Requests', {
        status: 429,
      })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      maxRetries: 1,
    })

    await assert.rejects(
      () =>
        client.request({
          method: 'GET',
          url: 'https://api.spotify.com/v1/me',
        }),
      (error: any) => error.name === 'RateLimitError'
    )
  })

  await t.test('retries on network error', async () => {
    let callCount = 0

    globalThis.fetch = (async (url: string) => {
      callCount++
      if (callCount < 2) {
        throw new TypeError('Network error')
      }
      return new Response('OK', { status: 200 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      maxRetries: 3,
    })

    const response = await client.request({
      method: 'GET',
      url: 'https://api.spotify.com/v1/me',
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(callCount, 2)
  })

  await t.test('fails after max retries', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Network error')
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      maxRetries: 2,
    })

    await assert.rejects(
      () =>
        client.request({
          method: 'GET',
          url: 'https://api.spotify.com/v1/me',
        }),
      (error: any) => error instanceof TypeError
    )
  })

  await t.test('includes response headers in result', async () => {
    globalThis.fetch = (async () => {
      const response = new Response('OK', { status: 200 })
      // Response constructor doesn't allow setting headers easily, so use a workaround
      Object.defineProperty(response, 'headers', {
        value: new Map([
          ['content-type', 'application/json'],
          ['x-rate-limit-remaining', '59'],
        ]) as any,
      })
      return response
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
    })

    const response = await client.request({
      method: 'GET',
      url: 'https://api.spotify.com/v1/me',
    })

    assert.strictEqual(response.headers.get('content-type'), 'application/json')
    assert.strictEqual(response.headers.get('x-rate-limit-remaining'), '59')
  })

  await t.test('does not retry 4xx errors', async () => {
    let callCount = 0

    globalThis.fetch = (async () => {
      callCount++
      return new Response('Not Found', { status: 404 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      maxRetries: 3,
    })

    await assert.rejects(
      () =>
        client.request({
          method: 'GET',
          url: 'https://api.spotify.com/v1/me',
        }),
      (error: any) => (error as any).status === 404
    )

    assert.strictEqual(callCount, 1) // No retries for 4xx
  })
})
