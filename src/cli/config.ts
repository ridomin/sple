import { existsSync, readFileSync } from 'node:fs'
import { getConfigFilePath } from '../core/config/paths.js'
import type { ProviderId } from '../core/provider/capabilities.js'
import { UsageError } from '../core/provider/errors.js'

export const PROVIDER_IDS: readonly ProviderId[] = ['spotify', 'youtube-music', 'fake']
export const DEFAULT_PROVIDER: ProviderId = 'spotify'

export interface Config {
  provider: ProviderId
  verbose: boolean
  spotifyClientId?: string
  youtubeMusicClientId?: string
  googleClientSecret?: string
}

export interface GlobalFlags {
  provider?: string
  verbose?: boolean
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value)
}

/**
 * Parse a .env file and return key-value pairs (simple parser, no interpolation).
 * Skips comments (lines starting with #) and empty lines.
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.substring(0, eq).trim()
    const val = trimmed.substring(eq + 1).trim()
    // Remove quotes if present
    result[key] = val.replace(/^["']|["']$/g, '')
  }
  return result
}

/**
 * Load the user's .env file (ADR-0004) into process.env. Variables already
 * set in the environment win over the file. Missing file is not an error.
 * Uses process.loadEnvFile on Node.js 20.13+, falls back to manual parsing on older versions.
 */
export function loadEnvFile(path: string = getConfigFilePath('.env')): boolean {
  if (!existsSync(path)) return false
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path)
  } else {
    // Fallback for Node.js <20.13.0
    const content = readFileSync(path, 'utf8')
    const vars = parseEnvFile(content)
    for (const [key, value] of Object.entries(vars)) {
      if (!(key in process.env)) {
        process.env[key] = value
      }
    }
  }
  return true
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() !== '' ? v.trim() : undefined
}

/** Build the config. Precedence: flags > env (incl. .env) > defaults. */
export function loadConfig(
  flags: GlobalFlags = {},
  env: NodeJS.ProcessEnv = process.env
): Config {
  const rawProvider = nonEmpty(flags.provider) ?? nonEmpty(env.SPLE_DEFAULT_PROVIDER) ?? DEFAULT_PROVIDER
  if (!isProviderId(rawProvider)) {
    throw new UsageError(
      `Unknown provider '${rawProvider}'. Valid providers: ${PROVIDER_IDS.join(', ')}`
    )
  }

  return {
    provider: rawProvider,
    verbose: flags.verbose ?? false,
    spotifyClientId: nonEmpty(env.SPLE_SPOTIFY_CLIENT_ID),
    youtubeMusicClientId: nonEmpty(env.SPLE_YOUTUBE_MUSIC_CLIENT_ID),
    googleClientSecret: nonEmpty(env.SPLE_GOOGLE_CLIENT_SECRET),
  }
}
