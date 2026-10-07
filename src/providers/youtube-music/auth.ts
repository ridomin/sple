import type { ProviderAuth, AuthStatus, LoginMode } from '../../core/provider/provider.js'
import { loadTokens, saveTokens, deleteTokens, type StoredToken } from '../../core/config/token-store.js'
import { OAuthHandler } from '../../core/auth/oauth-handler.js'
import type { OAuthConfig } from '../../core/auth/auth.js'
import { AuthRequiredError, ProviderError } from '../../core/provider/errors.js'
import { assertAnyScope, assertScopes, grantedScopes, missingScopes } from '../../core/auth/scopes.js'
import { YOUTUBE_LOGIN_SCOPES, YOUTUBE_OPERATION_SCOPES, type YouTubeOperation } from './scopes.js'
import { parseOAuthErrorCode } from '../../core/auth/oauth-errors.js'

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Google only returns a refresh_token for offline access, and on repeat consent only with prompt=consent
const GOOGLE_AUTH_PARAMS = { access_type: 'offline', prompt: 'consent' }

/** Google token response, as far as sple reads it. */
interface GoogleTokens {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  scope?: string
  /** Only sent while the OAuth app is in Testing status (refresh tokens then last 7 days). */
  refreshTokenExpiresIn?: number
}

const isoIn = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()

export class YouTubeMusicAuth implements ProviderAuth {
  private config: OAuthConfig
  private oauthHandler?: OAuthHandler
  private token?: StoredToken

  constructor(
    clientId: string,
    clientSecret: string,
    private readonly configDir?: string
  ) {
    this.config = {
      clientId,
      clientSecret,
      scopes: [...YOUTUBE_LOGIN_SCOPES],
    }
  }

  async login(opts: { mode: LoginMode; scopes: string[]; interaction?: any }): Promise<AuthStatus> {
    if (!opts.interaction) {
      throw new ProviderError('YouTube Music login requires an interactive session')
    }

    const scopes = (opts.scopes?.length ?? 0) > 0 ? opts.scopes : this.config.scopes
    const config: OAuthConfig = {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      scopes,
      extraAuthParams: GOOGLE_AUTH_PARAMS,
    }

    const handler = new OAuthHandler(config, GOOGLE_AUTHORIZE_URL)
    this.oauthHandler = handler

    try {
      const redirect = await handler.runLogin(opts.mode as 'loopback' | 'no-browser' | 'manual', opts.interaction)

      const tokenResult = await this.exchangeCodeForToken(
        redirect.code,
        redirect.codeVerifier,
        redirect.redirectUri
      )

      const user = await this.getUserInfo(tokenResult.accessToken)

      const storedToken: StoredToken = {
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        expiresAt: new Date(Date.now() + (tokenResult.expiresIn ?? 3600) * 1000).toISOString(),
        scopes: grantedScopes(tokenResult.scope, config.scopes),
        userId: user.id,
        displayName: user.displayName,
        grantedAt: new Date().toISOString(),
        ...(tokenResult.refreshTokenExpiresIn !== undefined
          ? { refreshTokenExpiresAt: isoIn(tokenResult.refreshTokenExpiresIn) }
          : {}),
      }

      await saveTokens('youtube-music', storedToken, this.configDir)
      this.token = storedToken

      return {
        loggedIn: true,
        user: { id: user.id, displayName: user.displayName },
        scopes: storedToken.scopes,
        expiresAt: storedToken.expiresAt,
        refreshTokenExpiresAt: storedToken.refreshTokenExpiresAt,
        missingScopes: missingScopes(config.scopes, storedToken.scopes),
      }
    } finally {
      handler.cleanup()
    }
  }

  /** Read from tokens.json only; never refreshes or calls the network (ADR-0007 A3). */
  async status(): Promise<AuthStatus> {
    const token = loadTokens('youtube-music', this.configDir)
    if (!token) {
      return { loggedIn: false, scopes: [] }
    }
    return {
      loggedIn: true,
      user: { id: token.userId, displayName: token.displayName ?? token.userId },
      scopes: token.scopes,
      expiresAt: token.expiresAt,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt,
    }
  }

  async logout(): Promise<{ revoked: boolean; deletedData: string[] }> {
    const token = loadTokens('youtube-music', this.configDir)

    let revoked = false
    if (token?.accessToken) {
      try {
        await this.revokeToken(token.accessToken)
        revoked = true
      } catch {
        // Local tokens are deleted even if revocation fails (ADR-0010 §4)
      }
    }

    deleteTokens('youtube-music', this.configDir)
    this.token = undefined

    // sple keeps no other YouTube data (no match cache or migration state yet).
    return { revoked, deletedData: ['access_token', 'refresh_token'] }
  }

  /**
   * The stored token, refreshed first when the access token has expired.
   * Refresh failures propagate (e.g. AuthRequiredError('revoked')), so an
   * expired grant is never reported as "not logged in".
   */
  async getToken(): Promise<StoredToken | null> {
    const token = this.token ?? loadTokens('youtube-music', this.configDir)
    if (!token) {
      return null
    }
    if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
      return this.refresh(token)
    }
    return token
  }

  async refresh(token: StoredToken): Promise<StoredToken> {
    if (!token.refreshToken) {
      throw new AuthRequiredError('No YouTube Music refresh token stored; run "sple auth login --provider youtube-music"', 'token-expired')
    }

    const tokens = await this.refreshToken(token.refreshToken)
    // Keep every stored field; replace scopes and the refresh-token expiry only when sent (ADR-0010 §3).
    const updated: StoredToken = {
      ...token,
      accessToken: tokens.accessToken,
      expiresAt: isoIn(tokens.expiresIn ?? 3600),
      scopes: grantedScopes(tokens.scope, token.scopes),
      ...(tokens.refreshTokenExpiresIn !== undefined
        ? { refreshTokenExpiresAt: isoIn(tokens.refreshTokenExpiresIn) }
        : {}),
    }

    saveTokens('youtube-music', updated, this.configDir)
    this.token = updated
    return updated
  }

  async requireScopes(scopes: readonly string[]): Promise<StoredToken> {
    const token = await this.getToken()
    if (!token) {
      throw new AuthRequiredError('Not logged in', 'no-token')
    }
    assertScopes(token.scopes, scopes)
    return token
  }

  /** Check, before an API call, that the token has a scope that allows `op` (YOUTUBE_OPERATION_SCOPES). */
  async requireOperation(op: YouTubeOperation): Promise<StoredToken> {
    const token = await this.getToken()
    if (!token) {
      throw new AuthRequiredError('Not logged in', 'no-token')
    }
    assertAnyScope(token.scopes, YOUTUBE_OPERATION_SCOPES[op])
    return token
  }

  cleanup(): void {
    this.oauthHandler?.cleanup()
  }

  private async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<GoogleTokens> {
    const body = new URLSearchParams()
    body.set('grant_type', 'authorization_code')
    body.set('code', code)
    body.set('client_id', this.config.clientId)
    body.set('client_secret', this.config.clientSecret || '')
    body.set('redirect_uri', redirectUri)
    body.set('code_verifier', codeVerifier)

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new ProviderError(`Google token exchange failed: ${error}`)
    }

    return parseGoogleTokens((await response.json()) as Record<string, unknown>)
  }

  private async refreshToken(refreshToken: string): Promise<GoogleTokens> {
    const body = new URLSearchParams()
    body.set('grant_type', 'refresh_token')
    body.set('refresh_token', refreshToken)
    body.set('client_id', this.config.clientId)
    body.set('client_secret', this.config.clientSecret || '')

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      const code = parseOAuthErrorCode(await response.text().catch(() => ''))
      if (code === 'invalid_grant') {
        throw new AuthRequiredError(
          'YouTube Music authorization expired or was revoked (Google expires refresh tokens after 7 days ' +
            'while the OAuth app is in Testing status); run "sple auth login --provider youtube-music"',
          'revoked'
        )
      }
      throw new ProviderError(`Google token refresh failed (HTTP ${response.status}${code ? `, ${code}` : ''})`)
    }

    return parseGoogleTokens((await response.json()) as Record<string, unknown>)
  }

  private async revokeToken(accessToken: string): Promise<void> {
    const body = new URLSearchParams()
    body.set('token', accessToken)
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      throw new ProviderError('Token revocation failed')
    }
  }

  private async getUserInfo(accessToken: string): Promise<{ id: string; displayName: string }> {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!response.ok) {
      throw new AuthRequiredError('Failed to fetch user info', 'no-token')
    }

    const data = (await response.json()) as Record<string, unknown>
    return {
      id: typeof data.id === 'string' ? data.id : '',
      displayName: typeof data.name === 'string' ? data.name : typeof data.id === 'string' ? (data.id as string) : 'User',
    }
  }
}

function parseGoogleTokens(data: Record<string, unknown>): GoogleTokens {
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new ProviderError('Google token endpoint returned no access token')
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    refreshTokenExpiresIn: typeof data.refresh_token_expires_in === 'number' ? data.refresh_token_expires_in : undefined,
  }
}
