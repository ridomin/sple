import type { ProviderAuth, AuthStatus, LoginMode } from '../../core/provider/provider.js'
import { loadTokens, saveTokens, deleteTokens, type StoredToken } from '../../core/config/token-store.js'
import { OAuthHandler } from '../../core/auth/oauth-handler.js'
import type { OAuthConfig } from '../../core/auth/auth.js'
import { AuthRequiredError, ProviderError } from '../../core/provider/errors.js'

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

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
      scopes: ['https://www.googleapis.com/auth/youtube'],
    }
  }

  async login(opts: { mode: LoginMode; scopes: string[] }): Promise<AuthStatus> {
    const config: OAuthConfig = {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      scopes: opts.scopes || this.config.scopes,
    }

    const handler = new OAuthHandler(config, GOOGLE_AUTHORIZE_URL)
    this.oauthHandler = handler

    try {
      const redirect = await handler.initiateLogin(opts.mode)

      const tokenResult = await this.exchangeCodeForToken(
        redirect.code,
        handler.getCodeVerifier(),
        handler.getRedirectUri()
      )

      const storedToken: StoredToken = {
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        expiresAt: new Date(Date.now() + (tokenResult.expiresIn ?? 3600) * 1000).toISOString(),
        scopes: config.scopes,
        userId: '',
        grantedAt: new Date().toISOString(),
      }

      await saveTokens('youtube-music', storedToken, this.configDir)
      this.token = storedToken

      const user = await this.getUserInfo(tokenResult.accessToken)

      return {
        loggedIn: true,
        user: { id: user.id, displayName: user.displayName },
        scopes: config.scopes,
        expiresAt: storedToken.expiresAt,
      }
    } finally {
      handler.cleanup()
    }
  }

  async status(): Promise<AuthStatus> {
    let token = this.token || (await loadTokens('youtube-music', this.configDir))

    if (!token) {
      return { loggedIn: false, scopes: [] }
    }

    // Check if expired
    if (new Date(token.expiresAt) < new Date()) {
      if (token.refreshToken) {
        try {
          const newToken = await this.refreshToken(token.refreshToken)
          const updated: StoredToken = {
            ...token,
            accessToken: newToken.accessToken,
            expiresAt: new Date(Date.now() + (newToken.expiresIn ?? 3600) * 1000).toISOString(),
          }
          await saveTokens('youtube-music', updated, this.configDir)
          this.token = updated
          token = updated
        } catch {
          return { loggedIn: false, scopes: [] }
        }
      } else {
        return { loggedIn: false, scopes: [] }
      }
    }

    return {
      loggedIn: true,
      user: { id: token.userId || '', displayName: token.displayName ?? token.userId },
      scopes: token.scopes,
      expiresAt: token.expiresAt,
    }
  }

  async logout(): Promise<{ revoked: boolean; deletedData: string[] }> {
    const token = await loadTokens('youtube-music', this.configDir)

    if (token?.accessToken) {
      try {
        await this.revokeToken(token.accessToken)
      } catch {
        // Revocation might fail; proceed with deletion
      }
    }

    await deleteTokens('youtube-music', this.configDir)
    this.token = undefined

    return {
      revoked: true,
      deletedData: ['access_token', 'refresh_token', 'match_cache', 'migration_state'],
    }
  }

  async getToken(): Promise<StoredToken | null> {
    let token = this.token || (await loadTokens('youtube-music', this.configDir))

    if (!token) {
      return null
    }

    // Refresh if expired
    if (new Date(token.expiresAt) < new Date()) {
      if (token.refreshToken) {
        try {
          const newToken = await this.refreshToken(token.refreshToken)
          const updated: StoredToken = {
            ...token,
            accessToken: newToken.accessToken,
            expiresAt: new Date(Date.now() + (newToken.expiresIn ?? 3600) * 1000).toISOString(),
          }
          await saveTokens('youtube-music', updated, this.configDir)
          this.token = updated
          return updated
        } catch {
          return null
        }
      } else {
        return null
      }
    }

    return token
  }

  async refresh(token: StoredToken): Promise<StoredToken> {
    if (!token.refreshToken) {
      throw new AuthRequiredError('No refresh token available')
    }

    const newToken = await this.refreshToken(token.refreshToken)
    const updated: StoredToken = {
      ...token,
      accessToken: newToken.accessToken,
      expiresAt: new Date(Date.now() + (newToken.expiresIn ?? 3600) * 1000).toISOString(),
    }

    await saveTokens('youtube-music', updated, this.configDir)
    this.token = updated
    return updated
  }

  async requireScopes(scopes: string[]): Promise<StoredToken> {
    const token = await this.getToken()
    if (!token) {
      throw new AuthRequiredError('Not logged in')
    }
    // TODO: Check if token has required scopes; if not, ask for re-login
    return token
  }

  cleanup(): void {
    this.oauthHandler?.cleanup()
  }

  private async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret || '',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    })

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new ProviderError(`Google token exchange failed: ${error}`)
    }

    const data = (await response.json()) as Record<string, unknown>
    if (typeof data.access_token !== 'string') {
      throw new ProviderError('No access token in response')
    }

    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    }
  }

  private async refreshToken(refreshToken: string): Promise<{ accessToken: string; expiresIn?: number }> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret || '',
    })

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      throw new ProviderError('Token refresh failed')
    }

    const data = (await response.json()) as Record<string, unknown>
    if (typeof data.access_token !== 'string') {
      throw new ProviderError('No access token in refresh response')
    }

    return {
      accessToken: data.access_token,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    }
  }

  private async revokeToken(accessToken: string): Promise<void> {
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken }).toString(),
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
      throw new AuthRequiredError('Failed to fetch user info')
    }

    const data = (await response.json()) as Record<string, unknown>
    return {
      id: typeof data.id === 'string' ? data.id : '',
      displayName: typeof data.name === 'string' ? data.name : typeof data.id === 'string' ? (data.id as string) : 'User',
    }
  }
}
