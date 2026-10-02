import type { Provider } from '../../../core/provider/provider.js'
import type { ProviderId } from '../../../core/provider/capabilities.js'
import { UsageError } from '../../../core/provider/errors.js'
import type { ProviderRegistry } from '../../provider-registry.js'
import type { Config } from '../../config.js'

/**
 * A provider an auth subcommand acts on. `provider` is absent when the
 * provider could not be constructed (e.g. its client ID is not configured);
 * `unavailable` then says why. Status and logout still work from the token
 * store for such providers, so a missing client ID never hides stored tokens.
 */
export interface AuthTarget {
  id: ProviderId
  displayName: string
  provider?: Provider
  unavailable?: string
}

export function resolveTarget(registry: ProviderRegistry, config: Config, id: ProviderId): AuthTarget {
  try {
    const provider = registry.create(id, config)
    return { id, displayName: provider.displayName, provider }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    return { id, displayName: id, unavailable: error.message }
  }
}

/** Every registered provider, in registration order. */
export function resolveAllTargets(registry: ProviderRegistry, config: Config): AuthTarget[] {
  return registry.list().map((id) => resolveTarget(registry, config, id))
}
