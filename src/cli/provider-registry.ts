import type { Provider } from '../core/provider/provider.js'
import type { ProviderId } from '../core/provider/capabilities.js'
import { UsageError } from '../core/provider/errors.js'
import { FakeProvider, parseFakeTrackRef } from '../providers/fake/index.js'
import { createSpotifyProvider } from '../providers/spotify/index.js'
import { parseSpotifyTrackRef } from '../providers/spotify/playlist-ref.js'
import { createYouTubeMusicProvider } from '../providers/youtube-music/index.js'
import { parseYouTubeTrackRef } from '../providers/youtube-music/playlist-ref.js'
import type { TrackRefParser } from '../core/import/file-reader.js'
import type { Config } from './config.js'
import type { HttpLogEntry } from '../core/http/client.js'

export type ProviderFactory = (config: Config) => Provider

export class ProviderRegistry {
  private factories = new Map<ProviderId, ProviderFactory>()
  private parsers = new Map<ProviderId, TrackRefParser>()

  /** `parseTrackRef` is the provider's pure ref parser, usable without creating the provider (no client ID needed). */
  register(id: ProviderId, factory: ProviderFactory, parseTrackRef?: TrackRefParser): this {
    this.factories.set(id, factory)
    if (parseTrackRef) this.parsers.set(id, parseTrackRef)
    return this
  }

  /** The registered providers' `parseTrackRef`, for CSV source inference (ADR-0008 A1). */
  trackRefParsers(): Partial<Record<ProviderId, TrackRefParser>> {
    return Object.fromEntries(this.parsers)
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

export interface DefaultRegistryOptions {
  /** HTTP attempt sink for `--debug` (ADR 0007 §6). */
  onHttp?: (entry: HttpLogEntry) => void
  /** Register the `fake` provider (`SPLE_ENABLE_FAKE_PROVIDER=1`; PRV-6). */
  enableFake?: boolean
}

export function createDefaultRegistry(options: DefaultRegistryOptions = {}): ProviderRegistry {
  const registry = new ProviderRegistry()
    .register('spotify', (config) =>
      createSpotifyProvider(
        requireClientId(config.spotifyClientId, 'SPLE_SPOTIFY_CLIENT_ID', 'Spotify'),
        undefined,
        { onHttp: options.onHttp }
      ),
      parseSpotifyTrackRef
    )
    .register('youtube-music', (config) =>
      createYouTubeMusicProvider(
        requireClientId(config.youtubeMusicClientId, 'SPLE_YOUTUBE_MUSIC_CLIENT_ID', 'YouTube Music'),
        config.googleClientSecret ?? ''
      ),
      parseYouTubeTrackRef
    )
  if (options.enableFake) registry.register('fake', () => new FakeProvider(), parseFakeTrackRef)
  return registry
}
