import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { YouTubeMusicAuth } from '../../../src/providers/youtube-music/auth.js'
import { ProviderError } from '../../../src/core/provider/errors.js'
import { saveTokens } from '../../../src/core/config/token-store.js'

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

  await t.test('handles cleanup gracefully', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret', tempDir)
    // Should not throw
    auth.cleanup()
  })
})
