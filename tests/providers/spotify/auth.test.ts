import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SpotifyAuth } from '../../../src/providers/spotify/auth.js'

test('SpotifyAuth', async (t) => {
  let tempDir: string

  await t.before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sple-spotify-auth-'))
  })

  await t.after(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  await t.test('returns auth status after login (stub)', async () => {
    const auth = new SpotifyAuth('test-client-id', tempDir)
    const status = await auth.login({ mode: 'no-browser', scopes: [] })

    assert.equal(status.loggedIn, true)
    assert.ok(status.user?.id)
    assert.equal(status.user?.id, 'stub-spotify-user')
    assert.ok(status.scopes)
    assert.ok(status.expiresAt)
  })

  await t.test('returns not logged in before login', async () => {
    await new SpotifyAuth('test-client-id', tempDir).logout()

    // Create a fresh auth instance without login
    const auth = new SpotifyAuth('test-client-id', tempDir)
    const status = await auth.status()

    assert.equal(status.loggedIn, false)
    assert.deepStrictEqual(status.scopes, [])
    assert.equal(status.user, undefined)
  })

  await t.test('logs out successfully', async () => {
    const auth = new SpotifyAuth('test-client-id', tempDir)
    await auth.login({ mode: 'no-browser', scopes: [] })
    const result = await auth.logout()

    assert.equal(result.revoked, false)
    assert.ok(result.deletedData.includes('access_token'))
  })

  await t.test('provides correct scopes for Spotify', async () => {
    const auth = new SpotifyAuth('test-client-id', tempDir)
    const status = await auth.login({ mode: 'no-browser', scopes: [] })

    const expectedScopes = [
      'playlist-read-private',
      'playlist-read-collaborative',
      'playlist-modify-public',
      'playlist-modify-private',
    ]
    assert.deepStrictEqual(status.scopes, expectedScopes)
  })

  await t.test('handles cleanup gracefully', async () => {
    const auth = new SpotifyAuth('test-client-id', tempDir)
    await auth.login({ mode: 'no-browser', scopes: [] })
    // Should not throw
    auth.cleanup()
  })
})
