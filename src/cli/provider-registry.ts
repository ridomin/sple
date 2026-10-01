import type { Provider } from '../core/provider/provider.js'
import type { ProviderId } from '../core/provider/capabilities.js'
import { UsageError } from '../core/provider/errors.js'
import { FakeProvider } from '../providers/fake/index.js'
import { SPOTIFY_PROVIDER } from '../providers/spotify/index.js'
import { YOUTUBE_MUSIC_PROVIDER } from '../providers/youtube-music/index.js'
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

export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register('spotify', () => SPOTIFY_PROVIDER)
    .register('youtube-music', () => YOUTUBE_MUSIC_PROVIDER)
    .register('fake', () => new FakeProvider())
}
