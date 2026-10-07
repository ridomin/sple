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

  const YOUTUBE = 'https://www.googleapis.com/auth/youtube'
  const PROFILE = 'https://www.googleapis.com/auth/userinfo.profile'

  // Run a manual-mode login against a stubbed Google token endpoint.
  async function loginWith(auth: YouTubeMusicAuth, tokenResponse: Record<string, unknown>) {
    let authorizationUrl = ''
    const interaction: LoginInteraction = {
      async showAuthorizationUrl(url) { authorizationUrl = url },
      promptForRedirectUrl: async () =>
        `http://127.0.0.1/callback?code=google-code&state=${new URL(authorizationUrl).searchParams.get('state')}`,
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://oauth2.googleapis.com/token') return Response.json(tokenResponse)
      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return Response.json({ id: 'google-user', name: 'Test User' })
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
    try {
      return await auth.login({ mode: 'manual', scopes: [], interaction })
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  await t.test('login stores the scopes Google granted, not the ones requested', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    // Granular consent: the user left the YouTube checkbox unticked.
    const status = await loginWith(auth, { access_token: 'a', refresh_token: 'r', expires_in: 3599, scope: PROFILE })

    assert.deepStrictEqual(status.scopes, [PROFILE])
    assert.deepStrictEqual(loadTokens('youtube-music', tempDir)?.scopes, [PROFILE])
  })

  await t.test('login falls back to the requested scopes when the response omits scope', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    await loginWith(auth, { access_token: 'a', refresh_token: 'r', expires_in: 3599 })

    assert.deepStrictEqual(loadTokens('youtube-music', tempDir)?.scopes, [YOUTUBE, PROFILE])
  })

  await t.test('refresh replaces the stored scopes with the granted ones', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      Response.json({ access_token: 'a2', expires_in: 3599, scope: PROFILE })) as unknown as typeof fetch
    try {
      const updated = await auth.refresh({
        accessToken: 'a', refreshToken: 'r', userId: 'u', scopes: [YOUTUBE, PROFILE], grantedAt: new Date().toISOString(),
      })
      assert.deepStrictEqual(updated.scopes, [PROFILE])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await t.test('requireScopes throws missing-scope when the token lacks a required scope', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    saveTokens('youtube-music', {
      accessToken: 'a', userId: 'u', scopes: [PROFILE], grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }, tempDir)

    await assert.rejects(
      () => auth.requireScopes([YOUTUBE]),
      (e: unknown) => e instanceof AuthRequiredError && e.reason === 'missing-scope' && e.scope === YOUTUBE
    )
  })

  await t.test('requireScopes returns the token when every required scope is granted', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    saveTokens('youtube-music', {
      accessToken: 'a', userId: 'u', scopes: [YOUTUBE, PROFILE], grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }, tempDir)

    const token = await auth.requireScopes([YOUTUBE])
    assert.equal(token.accessToken, 'a')
  })

  await t.test('handles cleanup gracefully', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    // Should not throw
    auth.cleanup()
  })
})
