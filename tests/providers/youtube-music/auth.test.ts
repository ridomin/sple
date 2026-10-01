import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { YouTubeMusicAuth } from '../../../src/providers/youtube-music/auth.js'
import { deleteTokens } from '../../../src/core/config/token-store.js'

test('YouTubeMusicAuth', async (t) => {
  let tempDir: string

  await t.before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sple-youtube-music-auth-'))
  })

  await t.after(() => {
    rmSync(tempDir, { recursive: true })
    // Clean up any tokens saved globally
    try {
      deleteTokens('youtube-music')
    } catch {
      // Ignore if tokens file doesn't exist
    }
  })

  await t.test('returns auth status after login (stub)', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret')
    const status = await auth.login({ mode: 'no-browser', scopes: [] })

    assert.equal(status.loggedIn, true)
    assert.ok(status.user?.id)
    assert.equal(status.user?.id, 'stub-user@gmail.com')
    assert.ok(status.scopes)
    assert.ok(status.expiresAt)
  })

  await t.test('returns not logged in before login', async () => {
    // Clean up any existing tokens first
    try {
      deleteTokens('youtube-music')
    } catch {
      // Ignore if tokens file doesn't exist
    }

    // Create a fresh auth instance without login
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret')
    const status = await auth.status()

    assert.equal(status.loggedIn, false)
    assert.deepStrictEqual(status.scopes, [])
    assert.equal(status.user, undefined)
  })

  await t.test('logs out successfully', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret')
    await auth.login({ mode: 'no-browser', scopes: [] })
    const result = await auth.logout()

    assert.equal(result.revoked, true)
    assert.ok(result.deletedData.includes('access_token'))
    assert.ok(result.deletedData.includes('refresh_token'))
  })

  await t.test('provides correct scopes for YouTube Music', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret')
    const status = await auth.login({ mode: 'no-browser', scopes: [] })

    const expectedScopes = ['https://www.googleapis.com/auth/youtube']
    assert.deepStrictEqual(status.scopes, expectedScopes)
  })

  await t.test('handles cleanup gracefully', async () => {
    const auth = new YouTubeMusicAuth('test-client-id', 'test-client-secret')
    await auth.login({ mode: 'no-browser', scopes: [] })
    // Should not throw
    auth.cleanup()
  })
})
