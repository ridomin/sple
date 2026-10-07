import { test } from 'node:test'
import * as assert from 'node:assert'
import { mkdtempSync, rmSync, readFileSync, statSync, chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, platform } from 'node:os'
import { loadTokens, saveTokens, deleteTokens, StoredToken } from '../../../src/core/config/token-store.js'

test('token store', async (t) => {
  let tempDir: string

  await t.before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sple-tokens-'))
  })

  await t.after(() => {
    rmSync(tempDir, { recursive: true })
  })

  const mockToken: StoredToken = {
    accessToken: 'access_123',
    refreshToken: 'refresh_456',
    expiresAt: '2026-10-02T00:00:00Z',
    scopes: ['playlist-read', 'playlist-modify'],
    userId: 'test-user',
    grantedAt: '2026-10-01T00:00:00Z',
  }

  await t.test('saveTokens and loadTokens', () => {
    saveTokens('spotify', mockToken, tempDir)
    const loaded = loadTokens('spotify', tempDir)

    assert.notStrictEqual(loaded, null)
    assert.deepStrictEqual(loaded, mockToken)
  })

  await t.test('loadTokens returns null if provider not found', () => {
    const loaded = loadTokens('youtube-music', tempDir)
    assert.strictEqual(loaded, null)
  })

  await t.test('loadTokens returns null if file does not exist', () => {
    const newDir = mkdtempSync(join(tmpdir(), 'sple-tokens-empty-'))
    const loaded = loadTokens('spotify', newDir)
    rmSync(newDir, { recursive: true })

    assert.strictEqual(loaded, null)
  })

  await t.test('deleteTokens removes provider data', () => {
    saveTokens('spotify', mockToken, tempDir)
    deleteTokens('spotify', tempDir)
    const loaded = loadTokens('spotify', tempDir)

    assert.strictEqual(loaded, null)
  })

  await t.test('validates required fields', () => {
    const invalidToken = { accessToken: '', userId: '', grantedAt: '', scopes: [] } as unknown as StoredToken
    assert.throws(() => saveTokens('spotify', invalidToken, tempDir), /must have a non-empty/)
  })

  await t.test('handles tokens without refreshToken', () => {
    const tokenWithoutRefresh: StoredToken = {
      accessToken: 'access',
      scopes: ['read'],
      userId: 'user',
      grantedAt: '2026-10-01T00:00:00Z',
    }
    saveTokens('spotify', tokenWithoutRefresh, tempDir)
    const loaded = loadTokens('spotify', tempDir)

    assert.strictEqual(loaded?.refreshToken, undefined)
    assert.strictEqual(loaded?.accessToken, 'access')
  })

  await t.test('handles tokens without expiresAt', () => {
    const tokenWithoutExpiry: StoredToken = {
      accessToken: 'access',
      scopes: ['read'],
      userId: 'user',
      grantedAt: '2026-10-01T00:00:00Z',
    }
    saveTokens('youtube-music', tokenWithoutExpiry, tempDir)
    const loaded = loadTokens('youtube-music', tempDir)

    assert.strictEqual(loaded?.expiresAt, undefined)
  })

  await t.test('round-trips optional displayName (schemaVersion stays 1)', () => {
    const token: StoredToken = { ...mockToken, displayName: 'Test User' }
    saveTokens('spotify', token, tempDir)
    assert.strictEqual(loadTokens('spotify', tempDir)?.displayName, 'Test User')
    const file = JSON.parse(readFileSync(join(tempDir, 'tokens.json'), 'utf-8'))
    assert.strictEqual(file.schemaVersion, 1)

    // Tokens without displayName still load (backward compatible)
    saveTokens('spotify', mockToken, tempDir)
    assert.strictEqual(loadTokens('spotify', tempDir)?.displayName, undefined)
  })

  await t.test('rejects non-string displayName', () => {
    const bad = { ...mockToken, displayName: 42 } as unknown as StoredToken
    assert.throws(() => saveTokens('spotify', bad, tempDir), /displayName must be a string/)
  })

  await t.test('supports multiple providers', () => {
    const token1: StoredToken = { ...mockToken, userId: 'user1' }
    const token2: StoredToken = { ...mockToken, userId: 'user2' }

    saveTokens('spotify', token1, tempDir)
    saveTokens('youtube-music', token2, tempDir)

    assert.strictEqual(loadTokens('spotify', tempDir)?.userId, 'user1')
    assert.strictEqual(loadTokens('youtube-music', tempDir)?.userId, 'user2')
  })

  await t.test('overwrites existing tokens', () => {
    const token1: StoredToken = { ...mockToken, accessToken: 'old' }
    const token2: StoredToken = { ...mockToken, accessToken: 'new' }

    saveTokens('spotify', token1, tempDir)
    saveTokens('spotify', token2, tempDir)

    assert.strictEqual(loadTokens('spotify', tempDir)?.accessToken, 'new')
  })

  const posix = platform() !== 'win32'
  const modeOf = (p: string) => statSync(p).mode & 0o777

  await t.test('saveTokens writes a new tokens.json with mode 0600 even with umask 0', { skip: !posix }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sple-tokens-mode-'))
    const oldUmask = process.umask(0)
    try {
      saveTokens('spotify', mockToken, dir)
      assert.strictEqual(modeOf(join(dir, 'tokens.json')), 0o600)
    } finally {
      process.umask(oldUmask)
      rmSync(dir, { recursive: true })
    }
  })

  await t.test('saveTokens replaces tokens.json atomically instead of rewriting it in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sple-tokens-atomic-'))
    try {
      const filePath = join(dir, 'tokens.json')
      saveTokens('spotify', mockToken, dir)
      const before = statSync(filePath).ino
      saveTokens('spotify', { ...mockToken, accessToken: 'new' }, dir)
      assert.notStrictEqual(statSync(filePath).ino, before)
      assert.deepStrictEqual(readdirSync(dir), ['tokens.json'])
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  await t.test('deleteTokens rewrites tokens.json with mode 0600', { skip: !posix }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sple-tokens-del-'))
    try {
      const filePath = join(dir, 'tokens.json')
      saveTokens('spotify', mockToken, dir)
      saveTokens('youtube-music', mockToken, dir)
      chmodSync(filePath, 0o644)
      deleteTokens('spotify', dir)
      assert.strictEqual(modeOf(filePath), 0o600)
      assert.deepStrictEqual(readdirSync(dir), ['tokens.json'])
      assert.strictEqual(loadTokens('youtube-music', dir)?.userId, mockToken.userId)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
