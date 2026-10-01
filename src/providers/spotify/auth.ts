import type { ProviderAuth, AuthStatus } from '../../core/provider/provider.js'
import { loadTokens, saveTokens, deleteTokens } from '../../core/config/token-store.js'
import { OAuthHandler } from '../../core/auth/oauth-handler.js'
import type { OAuthConfig } from '../../core/auth/auth.js'

export class SpotifyAuth implements ProviderAuth {
  private config: OAuthConfig
  private oauthHandler?: OAuthHandler

  constructor(clientId: string) {
    this.config = {
      clientId,
      scopes: [
        'playlist-read-private',
        'playlist-read-collaborative',
        'playlist-modify-public',
        'playlist-modify-private',
      ],
    }
  }

  async login(opts: { mode: 'loopback' | 'no-browser' | 'manual'; scopes: string[] }): Promise<AuthStatus> {
    // Stub: in M1, this will call Spotify's /authorize and /token endpoints
    const handler = new OAuthHandler(this.config, 'https://accounts.spotify.com/authorize')
    this.oauthHandler = handler

    await handler.initiateLogin(opts.mode)

    // In real implementation, we'd:
    // 1. Print login.authorizationUrl (or open browser for loopback)
    // 2. Wait for redirect
    // 3. Exchange code for token via POST to https://accounts.spotify.com/api/token
    // 4. Save token to token-store

    // Stub response
    const stubToken = {
      accessToken: 'stub-spotify-access-token',
      refreshToken: 'stub-spotify-refresh-token',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      scopes: this.config.scopes,
      userId: 'stub-spotify-user',
      grantedAt: new Date().toISOString(),
    }

    await saveTokens('spotify', stubToken)

    return {
      loggedIn: true,
      user: { id: 'stub-spotify-user', displayName: 'Stub Spotify User' },
      scopes: this.config.scopes,
      expiresAt: stubToken.expiresAt,
    }
  }

  async status(): Promise<AuthStatus> {
    const token = await loadTokens('spotify')

    if (!token) {
      return {
        loggedIn: false,
        scopes: [],
      }
    }

    return {
      loggedIn: true,
      user: { id: token.userId, displayName: token.userId },
      scopes: token.scopes,
      expiresAt: token.expiresAt,
    }
  }

  async logout(): Promise<{ revoked: boolean; deletedData: string[] }> {
    await deleteTokens('spotify')

    // Spotify does not support revocation, so we just delete local tokens
    return {
      revoked: false,
      deletedData: ['access_token'],
    }
  }

  cleanup(): void {
    this.oauthHandler?.cleanup()
  }
}
