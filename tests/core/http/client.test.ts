import { test } from 'node:test'
import * as assert from 'node:assert'
import { HttpClient } from '../../../src/core/http/client.js'
import type { StoredToken } from '../../../src/core/config/token-store.js'
import {
  NotFoundError,
  AccessRestrictedError,
  RateLimitError,
  AuthRequiredError,
} from '../../../src/core/provider/errors.js'

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

  await t.test('automatic token injection', async () => {
    mockFetchCallCount = 0
    mockFetchCalls.length = 0
    mockFetchResponse = new Response('OK', { status: 200 })

    const token: StoredToken = {
      accessToken: 'auto_token_123',
      refreshToken: 'refresh_456',
      scopes: ['read'],
      userId: 'user1',
      grantedAt: '2026-10-01T00:00:00Z',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }

    const client = new HttpClient({
      providerId: 'spotify',
      getToken: async () => token,
    })

    const response = await client.request({
      method: 'GET',
      url: 'https://api.spotify.com/v1/me',
    })

    assert.strictEqual(response.status, 200)
    const authHeader = mockFetchCalls[0].headers?.Authorization
    assert.strictEqual(authHeader, 'Bearer auto_token_123')
  })

  await t.test('proactive refresh fires when token expires within 60s', async () => {
    mockFetchCallCount = 0
    mockFetchCalls.length = 0

    let refreshCalled = false
    const expiringToken: StoredToken = {
      accessToken: 'expiring_token',
      refreshToken: 'refresh_old',
      scopes: ['read'],
      userId: 'user1',
      grantedAt: '2026-10-01T00:00:00Z',
      expiresAt: new Date(Date.now() + 30000).toISOString(), // 30 seconds
    }

    const newToken: StoredToken = {
      accessToken: 'new_token_after_refresh',
      refreshToken: 'refresh_new',
      scopes: ['read'],
      userId: 'user1',
      grantedAt: '2026-10-01T00:00:00Z',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      mockFetchCallCount++
      const headers = init?.headers as Record<string, string>
      const authToken = headers?.Authorization?.replace('Bearer ', '')

      if (authToken === 'new_token_after_refresh') {
        return new Response('OK', { status: 200 })
      }
      return new Response('Unauthorized', { status: 401 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      getToken: async () => expiringToken,
      refresh: async (token) => {
        refreshCalled = true
        return newToken
      },
    })

    const response = await client.request({
      method: 'GET',
      url: 'https://api.spotify.com/v1/me',
    })

    assert.strictEqual(response.status, 200)
    assert.strictEqual(refreshCalled, true)
  })

  await t.test('single-flight: 10 concurrent 401s trigger exactly 1 refresh', async () => {
    mockFetchCallCount = 0
    mockFetchCalls.length = 0

    let refreshCount = 0
    const token: StoredToken = {
      accessToken: 'old_token',
      refreshToken: 'refresh',
      scopes: ['read'],
      userId: 'user1',
      grantedAt: '2026-10-01T00:00:00Z',
    }

    const newToken: StoredToken = {
      accessToken: 'new_shared_token',
      refreshToken: 'refresh',
      scopes: ['read'],
      userId: 'user1',
      grantedAt: '2026-10-01T00:00:00Z',
    }

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      const authToken = headers?.Authorization?.replace('Bearer ', '')

      if (authToken === 'new_shared_token') {
        return new Response('OK', { status: 200 })
      }
      return new Response('Unauthorized', { status: 401 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      getToken: async () => token,
      refresh: async () => {
        refreshCount++
        // Simulate network delay for refresh
        await new Promise((r) => setTimeout(r, 10))
        return newToken
      },
    })

    // Make 10 concurrent requests
    const promises = Array.from({ length: 10 }, () =>
      client.request({
        method: 'GET',
        url: 'https://api.spotify.com/v1/me',
      })
    )

    const results = await Promise.all(promises)

    // All should succeed
    results.forEach((res) => assert.strictEqual(res.status, 200))

    // Refresh should only be called once (single-flight)
    assert.strictEqual(refreshCount, 1)
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

  await t.test('Retry-After: 3600 exceeds maxWaitMs and throws immediately', async () => {
    globalThis.fetch = (async () => {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'retry-after': '3600' }, // 1 hour
      })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      maxWaitMs: 120000, // 2 minutes
    })

    await assert.rejects(
      () =>
        client.request({
          method: 'GET',
          url: 'https://api.spotify.com/v1/me',
        }),
      (error: any) => error instanceof RateLimitError
    )
  })

  await t.test('404 maps to NotFoundError', async () => {
    globalThis.fetch = (async () => {
      return new Response('Not Found', { status: 404 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
    })

    await assert.rejects(
      () =>
        client.request({
          method: 'GET',
          url: 'https://api.spotify.com/v1/me',
        }),
      (error: any) => error instanceof NotFoundError
    )
  })

  await t.test('403 maps to AccessRestrictedError', async () => {
    globalThis.fetch = (async () => {
      return new Response('Forbidden', { status: 403 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
    })

    await assert.rejects(
      () =>
        client.request({
          method: 'GET',
          url: 'https://api.spotify.com/v1/me',
        }),
      (error: any) => error instanceof AccessRestrictedError
    )
  })

  await t.test('mapError hook allows adapter-specific error mapping', async () => {
    globalThis.fetch = (async () => {
      return new Response('Payment Required', { status: 402 })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
      mapError: (res) => {
        if (res.status === 402) {
          return new AccessRestrictedError(
            'Premium required',
            'premium-required'
          )
        }
        return undefined
      },
    })

    await assert.rejects(
      () =>
        client.request({
          method: 'GET',
          url: 'https://api.spotify.com/v1/me',
        }),
      (error: any) => {
        return (
          error instanceof AccessRestrictedError &&
          error.reason === 'premium-required'
        )
      }
    )
  })

  await t.test('requestJson validates response with custom validator', async () => {
    globalThis.fetch = (async () => {
      return new Response('{"id": "123", "name": "Test"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as any

    const client = new HttpClient({
      providerId: 'spotify',
    })

    interface User {
      id: string
      name: string
    }

    const result = await client.requestJson(
      {
        method: 'GET',
        url: 'https://api.spotify.com/v1/me',
      },
      (x) => {
        if (
          typeof x === 'object' &&
          x !== null &&
          'id' in x &&
          'name' in x
        ) {
          return x as User
        }
        throw new Error('Invalid user response')
      }
    )

    assert.strictEqual(result.id, '123')
    assert.strictEqual(result.name, 'Test')
  })

  await t.test('handles 401 with token refresh', async () => {
    mockFetchCallCount = 0
    mockFetchCalls.length = 0
    let callCount = 0
    const token: StoredToken = {
      accessToken: 'old_token_123',
      refreshToken: 'refresh_789',
      scopes: ['playlist-read'],
      userId: 'user123',
      grantedAt: '2026-10-01T00:00:00Z',
    }

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
      getToken: async () => token,
      refresh: async () => newToken,
    })

    const response = await client.request({
      method: 'GET',
      url: 'https://api.spotify.com/v1/me',
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
    })

    await assert.rejects(
      () =>
        client.request({
          method: 'GET',
          url: 'https://api.spotify.com/v1/me',
        }),
      (error: any) => error instanceof AuthRequiredError
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
      (error: any) => error instanceof RateLimitError
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
      (error: any) => error instanceof NotFoundError
    )

    assert.strictEqual(callCount, 1) // No retries for 4xx
  })

  await t.test('no token string in debug logs', async () => {
    // Capture debug output
    const debugLogs: string[] = []
    const originalWarn = console.warn
    const originalLog = console.log

    const captureOutput = (level: string) => (...args: any[]) => {
      const msg = args.join(' ')
      debugLogs.push(msg)
    }

    console.warn = captureOutput('warn')
    console.log = captureOutput('log')

    try {
      globalThis.fetch = (async () => {
        return new Response('{"user": "test"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as any

      const token: StoredToken = {
        accessToken: 'secret_token_xyz_do_not_log',
        refreshToken: 'secret_refresh_xyz',
        scopes: ['read'],
        userId: 'user1',
        grantedAt: '2026-10-01T00:00:00Z',
      }

      const client = new HttpClient({
        providerId: 'spotify',
        getToken: async () => token,
      })

      await client.request({
        method: 'GET',
        url: 'https://api.spotify.com/v1/me',
      })

      // Verify token strings never appear in logs
      const allLogs = debugLogs.join(' ')
      assert.ok(
        !allLogs.includes('secret_token_xyz_do_not_log'),
        'Token string should not appear in logs'
      )
      assert.ok(
        !allLogs.includes('secret_refresh_xyz'),
        'Refresh token string should not appear in logs'
      )
    } finally {
      console.warn = originalWarn
      console.log = originalLog
    }
  })
})

test('beforeAttempt runs before every attempt, retries included, and can stop a request (#84)', async () => {
  const original = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    return fetches === 1 ? new Response('', { status: 503 }) : new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  try {
    const seen: string[] = []
    const client = new HttpClient({ providerId: 'youtube-music', beforeAttempt: (req) => { seen.push(req.method) } })
    ;(client as unknown as { baseDelay: number }).baseDelay = 1
    await client.request({ method: 'GET', url: 'https://example.com/x' })
    assert.deepStrictEqual(seen, ['GET', 'GET'])
    assert.strictEqual(fetches, 2)

    const refusing = new HttpClient({ providerId: 'youtube-music', beforeAttempt: () => { throw new Error('over quota') } })
    await assert.rejects(() => refusing.request({ method: 'GET', url: 'https://example.com/x' }), /over quota/)
    assert.strictEqual(fetches, 2)
  } finally {
    globalThis.fetch = original
  }
})

test('mapError receives the request that failed (#84)', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch
  try {
    let seenUrl: string | undefined
    const client = new HttpClient({
      providerId: 'youtube-music',
      mapError: (_res, req) => { seenUrl = req?.url; return undefined },
    })
    await assert.rejects(() => client.request({ method: 'GET', url: 'https://example.com/search?q=a' }))
    assert.strictEqual(seenUrl, 'https://example.com/search?q=a')
  } finally {
    globalThis.fetch = original
  }
})
