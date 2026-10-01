import { existsSync } from 'node:fs'
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
 * Load the user's .env file (ADR-0004) into process.env. Variables already
 * set in the environment win over the file. Missing file is not an error.
 * Requires Node.js 20+ (process.loadEnvFile available since 20.13.0).
 */
export function loadEnvFile(path: string = getConfigFilePath('.env')): boolean {
  if (!existsSync(path)) return false
  process.loadEnvFile(path)
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
