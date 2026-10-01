import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'
import type { ProviderId } from '../provider/capabilities.js'
import { getConfigDir, getConfigFilePath } from './paths.js'

export const TOKENS_SCHEMA_VERSION = 1

export interface StoredToken {
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  scopes: string[]
  userId: string
  grantedAt: string
}

export interface TokensFile {
  schemaVersion: number
  providers: Record<ProviderId, { accounts: StoredToken[] }>
}

/**
 * Load tokens from the tokens.json file.
 * Returns the token for the given provider, or null if not found or file doesn't exist.
 */
export function loadTokens(providerId: ProviderId, configDir?: string): StoredToken | null {
  const filePath = configDir ? join(configDir, 'tokens.json') : getConfigFilePath('tokens.json', undefined)

  try {
    const content = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(content) as TokensFile

    // Validate schema version
    if (data.schemaVersion !== TOKENS_SCHEMA_VERSION) {
      throw new Error(`Unsupported tokens.json schema version: ${data.schemaVersion}`)
    }

    // Get the first account for the provider
    const providerData = data.providers?.[providerId]
    if (!providerData || !providerData.accounts || providerData.accounts.length === 0) {
      return null
    }

    const token = providerData.accounts[0]
    validateToken(token)
    return token
  } catch (error) {
    // File doesn't exist - that's OK, just return null
    if (error instanceof Error && error.message.includes('ENOENT')) {
      return null
    }
    throw error
  }
}

/**
 * Save a token to the tokens.json file.
 * Creates or updates the file as needed.
 */
export function saveTokens(providerId: ProviderId, token: StoredToken, configDir?: string): void {
  validateToken(token)

  const dir = configDir || getConfigDir()
  const filePath = join(dir, 'tokens.json')

  // Ensure directory exists
  mkdirSync(dir, { recursive: true })

  let data: TokensFile

  // Load existing file or create new
  try {
    const content = readFileSync(filePath, 'utf-8')
    data = JSON.parse(content) as TokensFile
  } catch {
    // File doesn't exist, create new
    data = {
      schemaVersion: TOKENS_SCHEMA_VERSION,
      providers: {} as Record<ProviderId, { accounts: StoredToken[] }>,
    }
  }

  // Ensure provider entry exists
  if (!data.providers[providerId]) {
    data.providers[providerId] = { accounts: [] }
  }

  // Replace first account (or add if none exists)
  data.providers[providerId].accounts[0] = token

  // Write to file
  writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8' })

  // Set permissions to user-only (0600) on POSIX
  if (platform() !== 'win32') {
    chmodSync(filePath, 0o600)
  }
}

/**
 * Delete tokens for a provider from the tokens.json file.
 */
export function deleteTokens(providerId: ProviderId, configDir?: string): void {
  const filePath = configDir ? join(configDir, 'tokens.json') : getConfigFilePath('tokens.json', undefined)

  try {
    const content = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(content) as TokensFile

    // Remove provider entry
    if (data.providers[providerId]) {
      delete data.providers[providerId]
    }

    // Write back
    writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8' })
  } catch (error) {
    // File doesn't exist - that's OK
    if (error instanceof Error && error.message.includes('ENOENT')) {
      return
    }
    throw error
  }
}

/**
 * Validate a StoredToken object.
 * Throws if invalid.
 */
function validateToken(token: unknown): asserts token is StoredToken {
  if (!token || typeof token !== 'object') {
    throw new Error('Token must be an object')
  }

  const t = token as Record<string, unknown>

  if (typeof t.accessToken !== 'string' || !t.accessToken) {
    throw new Error('Token must have a non-empty accessToken')
  }

  if (typeof t.userId !== 'string' || !t.userId) {
    throw new Error('Token must have a non-empty userId')
  }

  if (typeof t.grantedAt !== 'string' || !t.grantedAt) {
    throw new Error('Token must have a non-empty grantedAt')
  }

  if (!Array.isArray(t.scopes)) {
    throw new Error('Token scopes must be an array')
  }

  if (t.refreshToken !== undefined && typeof t.refreshToken !== 'string') {
    throw new Error('Token refreshToken must be a string if present')
  }

  if (t.expiresAt !== undefined && typeof t.expiresAt !== 'string') {
    throw new Error('Token expiresAt must be a string if present')
  }
}
