import type { Provider, ProviderAuth } from '../core/provider/provider.js'
import type { ProviderCapabilities, ProviderId } from '../core/provider/capabilities.js'
import { ProviderError, UsageError } from '../core/provider/errors.js'
import { FakeProvider } from '../providers/fake/index.js'
import type { Config } from './config.js'

export type ProviderFactory = (config: Config) => Provider

const notImplemented = (name: string) => (): never => {
  throw new ProviderError(`${name} provider is not implemented yet`)
}

/** Placeholder until the real adapters land (M0-10 / M1). */
function createStubProvider(id: ProviderId, displayName: string): Provider {
  const fail = notImplemented(displayName)
  const auth: ProviderAuth = { login: fail, status: fail, logout: fail }
  return {
    id,
    displayName,
    // Real capabilities arrive with the adapter.
    capabilities: {} as ProviderCapabilities,
    auth,
    search: fail,
    listPlaylists: fail,
    getPlaylist: fail,
    getPlaylistTracks: fail,
    getLikedTracks: fail,
    createPlaylist: fail,
    removePlaylist: fail,
    resolveTrack: fail,
    populatePlaylist: fail,
  }
}

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
    .register('spotify', () => createStubProvider('spotify', 'Spotify'))
    .register('youtube-music', () => createStubProvider('youtube-music', 'YouTube Music'))
    .register('fake', () => new FakeProvider())
}
