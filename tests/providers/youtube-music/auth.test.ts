import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { YouTubeMusicAuth } from '../../../src/providers/youtube-music/auth.js'
import { AuthRequiredError, ProviderError } from '../../../src/core/provider/errors.js'
import { saveTokens, loadTokens } from '../../../src/core/config/token-store.js'
import type { LoginInteraction } from '../../../src/core/provider/provider.js'

test('YouTubeMusicAuth', async (t) => {
  let tempDir: string

  await t.before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sple-youtube-music-auth-'))
  })

  await t.after(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  await t.test('login requires interaction', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)

    await assert.rejects(
      () => auth.login({ mode: 'no-browser', scopes: [] }),
      ProviderError
    )
  })

  await t.test('returns not logged in before login', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    const status = await auth.status()

    assert.equal(status.loggedIn, false)
    assert.deepStrictEqual(status.scopes, [])
    assert.equal(status.user, undefined)
  })

  await t.test('logs out successfully', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)

    // Save a test token first
    await saveTokens('youtube-music', {
      accessToken: 'test-token',
      userId: 'test-user',
      scopes: ['https://www.googleapis.com/auth/youtube'],
      grantedAt: new Date().toISOString(),
    }, tempDir)

    const result = await auth.logout()

    assert.equal(result.revoked, true)
    assert.ok(result.deletedData.includes('access_token'))
    assert.ok(result.deletedData.includes('refresh_token'))
  })

  await t.test('provides correct scopes configured', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    // Access the scopes via requireScopes which uses the token

    // First, save a test token with the required scopes
    await saveTokens('youtube-music', {
      accessToken: 'test-token',
      userId: 'test-user',
      scopes: [
        'https://www.googleapis.com/auth/youtube',
        'https://www.googleapis.com/auth/userinfo.profile'
      ],
      grantedAt: new Date().toISOString(),
    }, tempDir)

    const token = await auth.getToken()
    assert.ok(token?.scopes)
    assert.ok(token.scopes.includes('https://www.googleapis.com/auth/youtube'))
  })

  await t.test('login requests offline access and stores the refresh token', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    let authorizationUrl = ''
    const interaction: LoginInteraction = {
      async showAuthorizationUrl(url) { authorizationUrl = url },
      promptForRedirectUrl: async () =>
        `http://127.0.0.1/callback?code=google-code&state=${new URL(authorizationUrl).searchParams.get('state')}`,
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3599 })
      }
      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        return Response.json({ id: 'google-user', name: 'Test User' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    try {
      await auth.login({ mode: 'manual', scopes: [], interaction })
    } finally {
      globalThis.fetch = originalFetch
    }

    const u = new URL(authorizationUrl)
    assert.equal(u.searchParams.get('access_type'), 'offline')
    assert.equal(u.searchParams.get('prompt'), 'consent')

    const stored = await loadTokens('youtube-music', tempDir)
    assert.equal(stored?.refreshToken, 'refresh-1')
  })

  // #80: refresh-token expiry and invalid_grant
  const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString()
  const expiredAccess = (extra: Record<string, unknown> = {}) => ({
    accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: hourAgo(),
    scopes: ['https://www.googleapis.com/auth/youtube'], userId: 'u', grantedAt: hourAgo(), ...extra,
  })

  async function withTokenEndpoint<T>(status: number, body: unknown, fn: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://oauth2.googleapis.com/token') return Response.json(body, { status })
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
    try {
      return await fn()
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  const isRevoked = (e: unknown) =>
    e instanceof AuthRequiredError &&
    e.reason === 'revoked' &&
    /sple auth login --provider youtube-music/.test(e.message) &&
    /7 days/.test(e.message)

  await t.test('refresh maps invalid_grant to AuthRequiredError(revoked) explaining the 7-day limit', async () => {
    const auth = new YouTubeMusicAuth('id', 'secret', tempDir)
    await withTokenEndpoint(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, () =>
      assert.rejects(() => auth.refresh(expiredAccess()), isRevoked)
    )
  })

  await t.test('getToken propagates a revoked refresh instead of reporting "not logged in"', async () => {
    saveTokens('youtube-music', expiredAccess(), tempDir)
    const auth = new YouTubeMusicAuth('id', 'secret', tempDir)
    await withTokenEndpoint(400, { error: 'invalid_grant' }, () => assert.rejects(() => auth.getToken(), isRevoked))
  })

  await t.test('status reads the stored token without a network call, even when the access token expired', async () => {
    const refreshTokenExpiresAt = new Date(Date.now() + 86_400_000).toISOString()
    saveTokens('youtube-music', expiredAccess({ refreshTokenExpiresAt }), tempDir)
    const auth = new YouTubeMusicAuth('id', 'secret', tempDir)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('status must not call the network') }) as typeof fetch
    try {
      const status = await auth.status()
      assert.equal(status.loggedIn, true)
      assert.equal(status.refreshTokenExpiresAt, refreshTokenExpiresAt)
      assert.ok(status.expiresAt && new Date(status.expiresAt).getTime() < Date.now())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await t.test('login and refresh store refresh_token_expires_in as refreshTokenExpiresAt', async () => {
    const auth = new YouTubeMusicAuth('id', 'secret', tempDir)
    const refreshed = await withTokenEndpoint(200, { access_token: 'new', expires_in: 3599, refresh_token_expires_in: 86_400 }, () =>
      auth.refresh(expiredAccess())
    )
    const expiry = new Date(refreshed.refreshTokenExpiresAt ?? 0).getTime()
    assert.ok(Math.abs(expiry - (Date.now() + 86_400_000)) < 5_000, refreshed.refreshTokenExpiresAt)

    // A response without the field (app in production) keeps no expiry.
    const kept = await withTokenEndpoint(200, { access_token: 'new', expires_in: 3599 }, () => auth.refresh(expiredAccess()))
    assert.equal(kept.refreshTokenExpiresAt, undefined)
  })

  await t.test('handles cleanup gracefully', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    // Should not throw
    auth.cleanup()
  })
})
