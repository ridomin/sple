import createDebug from 'debug'
import type { ProviderAuth, AuthStatus, LoginInteraction, LoginMode } from '../../core/provider/provider.js'
import { loadTokens, saveTokens, deleteTokens, type StoredToken } from '../../core/config/token-store.js'
import { OAuthHandler } from '../../core/auth/oauth-handler.js'
import type { OAuthConfig } from '../../core/auth/auth.js'
import { AuthRequiredError, ProviderError, UsageError } from '../../core/provider/errors.js'
import { mapApiError, mapTokenEndpointError, type TokenGrant } from './errors.js'
import { SPOTIFY_LOGIN_SCOPES } from './scopes.js'
import { assertScopes, grantedScopes, missingScopes } from '../../core/auth/scopes.js'

export const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize'
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token'
export const SPOTIFY_ME_URL = 'https://api.spotify.com/v1/me'

export const SPOTIFY_ACCOUNT_APPS_URL = 'https://www.spotify.com/account/apps/'

/** Scopes requested at login: the union of the M1 scope table (scopes.ts). */
export const SPOTIFY_DEFAULT_SCOPES: readonly string[] = SPOTIFY_LOGIN_SCOPES

// Logs method, path, status, and duration only. Token-endpoint request and
// response bodies (and any token string) are never logged, even in debug mode.
const log = createDebug('sple:spotify:auth')

interface TokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

interface MeResponse {
  id: string
  display_name?: string | null
}

function parseTokenResponse(body: string): TokenResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ProviderError('Spotify token endpoint returned an invalid response')
  }
  const r = parsed as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || typeof r.access_token !== 'string' || !r.access_token) {
    throw new ProviderError('Spotify token endpoint returned no access token')
  }
  return {
    access_token: r.access_token,
    expires_in: typeof r.expires_in === 'number' ? r.expires_in : undefined,
    refresh_token: typeof r.refresh_token === 'string' && r.refresh_token ? r.refresh_token : undefined,
    scope: typeof r.scope === 'string' ? r.scope : undefined,
  }
}

function expiresAtFrom(expiresIn: number | undefined): string | undefined {
  return expiresIn === undefined ? undefined : new Date(Date.now() + expiresIn * 1000).toISOString()
}

export class SpotifyAuth implements ProviderAuth {
  private config: OAuthConfig
  private oauthHandler?: OAuthHandler

  constructor(clientId: string, private readonly configDir?: string) {
    this.config = {
      clientId,
      scopes: [...SPOTIFY_LOGIN_SCOPES],
    }
  }

  async login(opts: {
    mode: LoginMode
    scopes: string[]
    interaction?: LoginInteraction
  }): Promise<AuthStatus> {
    if (!opts.interaction) {
      throw new UsageError('Spotify login requires an interactive session')
    }
    const scopes = opts.scopes.length > 0 ? opts.scopes : this.config.scopes
    const handler = new OAuthHandler({ ...this.config, scopes }, SPOTIFY_AUTHORIZE_URL)
    this.oauthHandler = handler

    // 1-3: initiate, show/open the URL, wait for the redirect (or pasted URL)
    let redirect: { code: string; codeVerifier: string; redirectUri: string }
    try {
      redirect = await handler.runLogin(opts.mode, opts.interaction)
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError(`Spotify authorization failed: ${(error as Error).message}`)
    } finally {
      handler.cleanup()
    }

    // 4: exchange the code. redirect_uri is the exact string sent to /authorize.
    const grantedAt = new Date().toISOString()
    const tokens = await this.postToken(
      {
        grant_type: 'authorization_code',
        code: redirect.code,
        redirect_uri: redirect.redirectUri,
        client_id: this.config.clientId,
        code_verifier: redirect.codeVerifier,
      },
      'authorization_code'
    )

    // 5: identity. A Premium error here (S4) throws before anything is saved.
    const me = await this.fetchMe(tokens.access_token)

    // 6: persist with the *granted* scopes from the token response
    const stored: StoredToken = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: expiresAtFrom(tokens.expires_in),
      scopes: grantedScopes(tokens.scope, scopes),
      userId: me.id,
      displayName: me.display_name ?? undefined,
      grantedAt,
    }
    saveTokens('spotify', stored, this.configDir)

    return {
      loggedIn: true,
      user: { id: stored.userId, displayName: stored.displayName },
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
      missingScopes: missingScopes(scopes, stored.scopes),
    }
  }

  /**
   * Exchange the stored refresh token for a new access token and persist it.
   * Keeps the old refresh token unless Spotify rotates it.
   * `invalid_grant` → AuthRequiredError(…, 'revoked') (exit 3).
   */
  async refresh(token: StoredToken): Promise<StoredToken> {
    if (!token.refreshToken) {
      throw new AuthRequiredError(
        'No Spotify refresh token stored; run "sple auth login"',
        'token-expired'
      )
    }

    const tokens = await this.postToken(
      {
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: this.config.clientId,
      },
      'refresh_token'
    )

    const refreshed: StoredToken = {
      ...token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? token.refreshToken,
      expiresAt: expiresAtFrom(tokens.expires_in),
      scopes: grantedScopes(tokens.scope, token.scopes),
    }
    saveTokens('spotify', refreshed, this.configDir)
    return refreshed
  }

  async status(): Promise<AuthStatus> {
    const token = await loadTokens('spotify', this.configDir)

    if (!token) {
      return {
        loggedIn: false,
        scopes: [],
      }
    }

    return {
      loggedIn: true,
      user: { id: token.userId, displayName: token.displayName ?? token.userId },
      scopes: token.scopes,
      expiresAt: token.expiresAt,
    }
  }

  async logout(): Promise<{ revoked: boolean; deletedData: string[]; notice?: string }> {
    await deleteTokens('spotify', this.configDir)

    // Spotify has no token revocation endpoint, so only local tokens are deleted.
    return {
      revoked: false,
      deletedData: ['access_token', 'refresh_token'],
      notice:
        'Spotify has no revoke endpoint. To revoke sple\'s access to your account, ' +
        `remove the app at ${SPOTIFY_ACCOUNT_APPS_URL}`,
    }
  }

  /** The stored token, or null when not logged in. Used by the HttpClient. */
  async getToken(): Promise<StoredToken | null> {
    return loadTokens('spotify', this.configDir)
  }

  /**
   * Check, before an API call, that a token is stored and that it was granted
   * every scope in `required` (FR-AUTH-5). Returns the stored token.
   * No token → AuthRequiredError('no-token'); missing scope → 'missing-scope' naming it.
   */
  async requireScopes(required: readonly string[]): Promise<StoredToken> {
    const token = loadTokens('spotify', this.configDir)
    if (!token) {
      throw new AuthRequiredError('Not logged in to Spotify; run "sple auth login"', 'no-token')
    }
    assertScopes(token.scopes, required)
    return token
  }

  cleanup(): void {
    this.oauthHandler?.cleanup()
  }

  private async postToken(params: Record<string, string>, grant: TokenGrant): Promise<TokenResponse> {
    const start = Date.now()
    let res: Response
    try {
      res = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      })
    } catch {
      log('%s', `POST /api/token (${grant}) → network error`)
      throw new ProviderError('Could not reach the Spotify token endpoint')
    }
    const body = await res.text()
    log('%s', `POST /api/token (${grant}) → ${res.status} (${Date.now() - start}ms)`)

    if (!res.ok) {
      throw mapTokenEndpointError(res.status, body, grant, res.headers.get('retry-after'))
    }
    return parseTokenResponse(body)
  }

  private async fetchMe(accessToken: string): Promise<MeResponse> {
    const start = Date.now()
    let res: Response
    try {
      res = await fetch(SPOTIFY_ME_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    } catch {
      log('%s', 'GET /v1/me → network error')
      throw new ProviderError('Could not reach the Spotify API')
    }
    log('%s', `GET /v1/me → ${res.status} (${Date.now() - start}ms)`)

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw mapApiError(res.status, res.headers.get('retry-after'), body)
    }
    let parsed: unknown
    try {
      parsed = await res.json()
    } catch {
      throw new ProviderError('Spotify /me returned an invalid response')
    }
    const me = parsed as Record<string, unknown> | null
    if (!me || typeof me.id !== 'string' || !me.id) {
      throw new ProviderError('Spotify /me returned no user id')
    }
    return {
      id: me.id,
      display_name: typeof me.display_name === 'string' ? me.display_name : null,
    }
  }
}
