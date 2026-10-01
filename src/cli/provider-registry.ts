import type { Provider } from '../core/provider/provider.js'
import type { ProviderId } from '../core/provider/capabilities.js'
import { UsageError } from '../core/provider/errors.js'
import { FakeProvider } from '../providers/fake/index.js'
import { createSpotifyProvider } from '../providers/spotify/index.js'
import { createYouTubeMusicProvider } from '../providers/youtube-music/index.js'
import type { Config } from './config.js'

export type ProviderFactory = (config: Config) => Provider

export class ProviderRegistry {
  private factories = new Map<ProviderId, ProviderFactory>()

  register(id: ProviderId, factory: ProviderFactory): this {
    this.factories.set(id, factory)
    return this
  }

  has(id: string): boolean {
    return this.factories.has(id as ProviderId)
  }

  list(): ProviderId[] {
    return [...this.factories.keys()]
  }

  create(id: string, config: Config): Provider {
    const factory = this.factories.get(id as ProviderId)
    if (!factory) {
      throw new UsageError(`Unknown provider '${id}'. Valid providers: ${this.list().join(', ')}`)
    }
    return factory(config)
  }
}

function requireClientId(value: string | undefined, envVar: string, name: string): string {
  if (!value || value.trim() === '') {
    throw new UsageError(
      `Missing ${name} client ID. Set ${envVar} in your environment or .env file.`
    )
  }
  return value
}

export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register('spotify', (config) =>
      createSpotifyProvider(
        requireClientId(config.spotifyClientId, 'SPLE_SPOTIFY_CLIENT_ID', 'Spotify')
      )
    )
    .register('youtube-music', (config) =>
      createYouTubeMusicProvider(
        requireClientId(config.youtubeMusicClientId, 'SPLE_YOUTUBE_MUSIC_CLIENT_ID', 'YouTube Music'),
        config.googleClientSecret ?? ''
      )
    )
    .register('fake', () => new FakeProvider())
}
