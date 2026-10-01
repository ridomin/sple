import type { ProviderAuth, AuthStatus } from '../provider/provider.js'
import type { StoredToken } from '../config/token-store.js'

// Re-export for convenience
export type { ProviderAuth, AuthStatus }

/**
 * Configuration for an OAuth provider (client credentials, scopes, etc.).
 * Loaded from environment variables and passed to OAuthHandler.
 */
export interface OAuthConfig {
  clientId: string
  clientSecret?: string // Required for some providers (e.g., Google)
  scopes: string[]
  redirectUri?: string // Defaults to loopback handler's URI
}

/**
 * Transient state stored during PKCE flow (not persisted to disk).
 * Used to validate the redirect response and exchange code for token.
 */
export interface StoredOAuthState {
  codeVerifier: string
  state: string
  expiresAt: number // Timestamp; typically 10 minutes from initiation
}

/**
 * Result of token exchange from authorization code.
 * Provider adapters map this to StoredToken for persistence.
 */
export interface TokenExchangeResult {
  accessToken: string
  refreshToken?: string
  expiresIn?: number // Seconds from now
  scope?: string
}

// Re-export StoredToken for convenience in auth context
export type { StoredToken }
