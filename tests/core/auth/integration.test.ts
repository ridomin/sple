import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeProvider } from '../../../src/providers/fake/index.js'
import {
  loadTokens,
  deleteTokens,
  saveTokens,
  type StoredToken,
} from '../../../src/core/config/token-store.js'

/**
 * Integration test suite for auth flow with FakeProvider.
 *
 * These tests verify the complete lifecycle:
 * - login saves tokens
 * - status loads and reflects token state
 * - logout deletes tokens
 * - token expiry warnings work
 * - multi-provider logins maintain separate tokens
 */
test('Auth integration flow', async (t) => {
  let testDir: string

  // Setup a temporary config directory for each test
  const setupTestDir = (): string => {
    return mkdtempSync(join(tmpdir(), 'sple-auth-test-'))
  }

  const cleanupTestDir = (dir: string): void => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }

  await t.test('completes full flow: login → status → logout', async () => {
    testDir = setupTestDir()
    try {
      const provider = new FakeProvider({ configDir: testDir })

      // Step 1: Login
      const loginStatus = await provider.auth.login({
        mode: 'no-browser',
        scopes: ['test-scope'],
      })
      assert.equal(loginStatus.loggedIn, true, 'login should return loggedIn=true')
      assert.ok(loginStatus.user?.id, 'login should return user id')
      assert.deepEqual(loginStatus.scopes, ['test-scope'], 'login should return requested scopes')
      assert.ok(loginStatus.expiresAt, 'login should return expiresAt')

      // Step 2: Verify token was saved
      const token = loadTokens('fake', testDir)
      assert.ok(token, 'token should be saved after login')
      assert.ok(token?.accessToken, 'token should have accessToken')
      assert.equal(token?.userId, 'fake-user', 'token should store userId')
      assert.deepEqual(token?.scopes, ['test-scope'], 'token should store requested scopes')
      assert.ok(token?.grantedAt, 'token should store grantedAt')

      // Step 3: Status reflects logged-in state
      const statusBefore = await provider.auth.status()
      assert.equal(statusBefore.loggedIn, true, 'status should return loggedIn=true')
      assert.equal(statusBefore.user?.id, loginStatus.user?.id, 'status user id should match login')
      assert.deepEqual(
        statusBefore.scopes,
        ['test-scope'],
        'status scopes should match login scopes'
      )
      assert.ok(statusBefore.expiresAt, 'status should return expiresAt')

      // Step 4: Logout
      const logoutResult = await provider.auth.logout()
      assert.ok(logoutResult.revoked, 'logout should return revoked=true')
      assert.ok(
        logoutResult.deletedData.includes('access_token'),
        'logout should report deleted access_token'
      )

      // Step 5: Verify token was deleted
      const tokenAfter = loadTokens('fake', testDir)
      assert.equal(tokenAfter, null, 'token should be deleted after logout')

      // Step 6: Status reflects logged-out state
      const statusAfter = await provider.auth.status()
      assert.equal(statusAfter.loggedIn, false, 'status should return loggedIn=false after logout')
      assert.deepEqual(statusAfter.scopes, [], 'status scopes should be empty after logout')
      assert.equal(
        statusAfter.user,
        undefined,
        'status user should be undefined after logout'
      )
    } finally {
      cleanupTestDir(testDir)
    }
  })

  await t.test('handles multi-provider simultaneous login', async () => {
    testDir = setupTestDir()
    try {
      // Create a second provider ID to simulate multiple providers
      const provider1 = new FakeProvider({ userId: 'user1', configDir: testDir })
      const provider2 = new FakeProvider({ userId: 'user2', configDir: testDir })

      // Login to first provider
      const status1 = await provider1.auth.login({
        mode: 'no-browser',
        scopes: ['scope-a', 'scope-b'],
      })
      assert.ok(status1.loggedIn, 'provider1 login should succeed')

      // Login to second provider
      const status2 = await provider2.auth.login({
        mode: 'no-browser',
        scopes: ['scope-x', 'scope-y'],
      })
      assert.ok(status2.loggedIn, 'provider2 login should succeed')

      // Verify both tokens are stored (they share the same provider ID 'fake')
      // The second login would overwrite the first since both use 'fake' ID
      const token = loadTokens('fake', testDir)
      assert.ok(token, 'a token should be stored')

      // Verify the second login overwrote the first (expected behavior for single account)
      assert.equal(token?.userId, 'user2', 'second login should overwrite first')
      assert.deepEqual(
        token?.scopes,
        ['scope-x', 'scope-y'],
        'second login scopes should be stored'
      )

      // Logout from provider2
      const logout2 = await provider2.auth.logout()
      assert.ok(logout2.revoked, 'provider2 logout should succeed')

      // Verify token is gone
      const tokenAfter = loadTokens('fake', testDir)
      assert.equal(tokenAfter, null, 'token should be deleted after second provider logout')

      // Status from provider1 should reflect logout
      const status1After = await provider1.auth.status()
      assert.equal(
        status1After.loggedIn,
        false,
        'provider1 status should show not logged in after logout'
      )
    } finally {
      cleanupTestDir(testDir)
    }
  })

  await t.test('status warns when token expires within 5 minutes', async () => {
    testDir = setupTestDir()
    try {
      const provider = new FakeProvider({ configDir: testDir })

      // Login normally (1 hour expiry)
      await provider.auth.login({
        mode: 'no-browser',
        scopes: ['test-scope'],
      })

      let status = await provider.auth.status()
      assert.ok(status.expiresAt, 'status should return expiresAt for normal token')

      // Calculate when token expires
      const expiresMs = new Date(status.expiresAt!).getTime() - Date.now()
      assert.ok(
        expiresMs > 5 * 60 * 1000,
        'normal token should expire after 5 minutes'
      )

      // Now manually create a token that expires in 2 minutes
      const soonToken: StoredToken = {
        accessToken: 'expiring-soon-token',
        refreshToken: 'expiring-soon-refresh',
        expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        scopes: ['test-scope'],
        userId: 'fake-user',
        grantedAt: new Date().toISOString(),
      }
      saveTokens('fake', soonToken, testDir)

      status = await provider.auth.status()
      assert.ok(status.expiresAt, 'status should return expiresAt for expiring token')

      const expiresInMs = new Date(status.expiresAt!).getTime() - Date.now()
      assert.ok(
        expiresInMs < 5 * 60 * 1000,
        'token should expire within 5 minutes'
      )

      // Note: The actual warning is shown by the CLI (status.ts), not by auth module
      // This test just verifies the token is correctly read and would trigger the warning
    } finally {
      cleanupTestDir(testDir)
    }
  })

  await t.test('login with different scopes creates correct token', async () => {
    testDir = setupTestDir()
    try {
      const provider = new FakeProvider({ configDir: testDir })

      // Login with empty scopes should default to ['all']
      const status1 = await provider.auth.login({
        mode: 'no-browser',
        scopes: [],
      })
      assert.deepEqual(
        status1.scopes,
        ['all'],
        'empty scopes should default to [all]'
      )

      let token = loadTokens('fake', testDir)
      assert.deepEqual(
        token?.scopes,
        ['all'],
        'token should store default scopes'
      )

      // Logout and try again with specific scopes
      await provider.auth.logout()

      const status2 = await provider.auth.login({
        mode: 'no-browser',
        scopes: ['playlist.read', 'playlist.modify'],
      })
      assert.deepEqual(
        status2.scopes,
        ['playlist.read', 'playlist.modify'],
        'specific scopes should be preserved'
      )

      token = loadTokens('fake', testDir)
      assert.deepEqual(
        token?.scopes,
        ['playlist.read', 'playlist.modify'],
        'token should store specific scopes'
      )
    } finally {
      cleanupTestDir(testDir)
    }
  })

  await t.test('status returns consistent user info across calls', async () => {
    testDir = setupTestDir()
    try {
      const provider = new FakeProvider({ userId: 'specific-user-id', configDir: testDir })

      await provider.auth.login({
        mode: 'no-browser',
        scopes: ['test-scope'],
      })

      // Call status multiple times
      const status1 = await provider.auth.status()
      const status2 = await provider.auth.status()

      assert.equal(
        status1.user?.id,
        status2.user?.id,
        'user id should be consistent'
      )
      assert.equal(
        status1.user?.id,
        'specific-user-id',
        'user id should match configured userId'
      )
      assert.deepEqual(
        status1.scopes,
        status2.scopes,
        'scopes should be consistent'
      )
      assert.equal(
        status1.expiresAt,
        status2.expiresAt,
        'expiresAt should be consistent'
      )
    } finally {
      cleanupTestDir(testDir)
    }
  })

  await t.test('logout without prior login returns no error', async () => {
    testDir = setupTestDir()
    try {
      const provider = new FakeProvider({ configDir: testDir })

      // Logout without login should not throw
      const result = await provider.auth.logout()
      assert.ok(result, 'logout should return a result')
      assert.ok(result.deletedData, 'logout should report deletedData')

      // Status should show not logged in
      const status = await provider.auth.status()
      assert.equal(status.loggedIn, false, 'status should show not logged in')
    } finally {
      cleanupTestDir(testDir)
    }
  })

  await t.test('login overwrites previous token', async () => {
    testDir = setupTestDir()
    try {
      const provider = new FakeProvider({ configDir: testDir })

      // First login
      const status1 = await provider.auth.login({
        mode: 'no-browser',
        scopes: ['scope-1'],
      })

      const token1 = loadTokens('fake', testDir)
      assert.ok(token1?.accessToken, 'first token should be saved')
      const accessToken1 = token1.accessToken

      // Second login
      const status2 = await provider.auth.login({
        mode: 'no-browser',
        scopes: ['scope-2'],
      })

      const token2 = loadTokens('fake', testDir)
      assert.ok(token2?.accessToken, 'second token should be saved')
      assert.notEqual(
        token2.accessToken,
        accessToken1,
        'second login should create new access token'
      )
      assert.deepEqual(
        token2.scopes,
        ['scope-2'],
        'second login should update scopes'
      )

      // Verify only one token exists
      const status = await provider.auth.status()
      assert.equal(status.loggedIn, true, 'status should show logged in')
    } finally {
      cleanupTestDir(testDir)
    }
  })

  await t.test('token contains all required fields', async () => {
    testDir = setupTestDir()
    try {
      const provider = new FakeProvider({ configDir: testDir })

      await provider.auth.login({
        mode: 'no-browser',
        scopes: ['test-scope'],
      })

      const token = loadTokens('fake', testDir)
      assert.ok(token, 'token should be stored')
      assert.ok(token?.accessToken, 'token should have accessToken')
      assert.ok(token?.refreshToken, 'token should have refreshToken')
      assert.ok(token?.expiresAt, 'token should have expiresAt')
      assert.ok(token?.userId, 'token should have userId')
      assert.ok(token?.grantedAt, 'token should have grantedAt')
      assert.ok(Array.isArray(token?.scopes), 'token should have scopes array')
    } finally {
      cleanupTestDir(testDir)
    }
  })
})
