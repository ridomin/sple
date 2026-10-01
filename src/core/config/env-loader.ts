import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './paths.js'

/**
 * Load and parse a .env file from the sple config directory.
 *
 * Returns an object with all environment variables from the .env file.
 * Comments (lines starting with #) and empty lines are ignored.
 * Env vars already in process.env are NOT overridden (they take precedence).
 *
 * Example .env file:
 * ```
 * # Spotify configuration
 * SPLE_SPOTIFY_CLIENT_ID=abc123
 * SPLE_DEFAULT_PROVIDER=spotify
 *
 * # YouTube Music configuration
 * # SPLE_YOUTUBE_MUSIC_CLIENT_ID=xyz789
 * ```
 */
export function loadEnv(configDir?: string): Record<string, string> {
  const dir = configDir || getConfigDir()
  const envFilePath = join(dir, '.env')

  const result: Record<string, string> = {}

  try {
    const content = readFileSync(envFilePath, 'utf-8')
    const lines = content.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue
      }

      // Parse KEY=VALUE
      const equalsIndex = trimmed.indexOf('=')
      if (equalsIndex === -1) {
        continue
      }

      const key = trimmed.substring(0, equalsIndex).trim()
      const value = trimmed.substring(equalsIndex + 1).trim()

      // Skip if key is empty
      if (!key) {
        continue
      }

      // Store the value, but don't override process.env
      // (process.env takes precedence over .env file)
      if (!(key in process.env)) {
        result[key] = value
      }
    }
  } catch (error) {
    // If file doesn't exist or can't be read, just return empty object
    // This is not an error condition - .env is optional
    if (error instanceof Error && error.message.includes('ENOENT')) {
      return result
    }
    throw error
  }

  return result
}

/**
 * Merge .env variables with process.env.
 * Variables already in process.env are not overridden.
 */
export function mergeEnv(envVars: Record<string, string>): void {
  for (const [key, value] of Object.entries(envVars)) {
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

/**
 * Load .env file and merge into process.env.
 * Shorthand for loadEnv() + mergeEnv().
 */
export function loadAndMergeEnv(configDir?: string): Record<string, string> {
  const envVars = loadEnv(configDir)
  mergeEnv(envVars)
  return envVars
}
