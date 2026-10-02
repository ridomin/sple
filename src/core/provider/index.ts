export type { ProviderCapabilities, ProviderId, ProviderOperation, QuotaModel } from './capabilities.js'

export {
  ProviderError,
  AuthRequiredError,
  NotFoundError,
  AccessRestrictedError,
  QuotaExhaustedError,
  RateLimitError,
  UsageError,
} from './errors.js'

export type {
  Provider,
  ProviderAuth,
  CanonicalTrack,
  PlaylistSummary,
  MatchCandidate,
  AuthStatus,
  Page,
  PageRequest,
  SearchType,
  SearchItem,
  SearchItemBase,
} from './provider.js'
