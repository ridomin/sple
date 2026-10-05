import type { ProviderAuth, AuthStatus } from '../../core/provider/provider.js'
import { loadTokens, saveTokens, deleteTokens } from '../../core/config/token-store.js'
import { OAuthHandler } from '../../core/auth/oauth-handler.js'
import type { OAuthConfig } from '../../core/auth/auth.js'

export class YouTubeMusicAuth implements ProviderAuth {
  private config: OAuthConfig
  private oauthHandler?: OAuthHandler

  constructor(clientId: string, clientSecret: string, private readonly configDir?: string) {
    this.config = {
      clientId,
      clientSecret,
      scopes: ['https://www.googleapis.com/auth/youtube'],
    }
  }

  async login(opts: { mode: 'loopback' | 'no-browser' | 'manual'; scopes: string[] }): Promise<AuthStatus> {
    // Stub: in M1, this will call Google's OAuth /authorize and /token endpoints
    const handler = new OAuthHandler(this.config, 'https://accounts.google.com/o/oauth2/v2/auth')
    this.oauthHandler = handler

    try {
      await handler.initiateLogin(opts.mode)

      // Stub response
      const stubToken = {
        accessToken: 'stub-google-access-token',
        refreshToken: 'stub-google-refresh-token',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        scopes: this.config.scopes,
        userId: 'stub-user@gmail.com',
        grantedAt: new Date().toISOString(),
      }

      await saveTokens('youtube-music', stubToken, this.configDir)

      return {
        loggedIn: true,
        user: { id: 'stub-user@gmail.com', displayName: 'Stub User' },
        scopes: this.config.scopes,
        expiresAt: stubToken.expiresAt,
      }
    } finally {
      // Stub flow never awaits a redirect; release the loopback server
      handler.cleanup()
    }
  }

  async status(): Promise<AuthStatus> {
    const token = await loadTokens('youtube-music', this.configDir)

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

  async logout(): Promise<{ revoked: boolean; deletedData: string[] }> {
    await deleteTokens('youtube-music', this.configDir)

    // Google supports revocation; in M1 we'd call the revoke endpoint
    return {
      revoked: true,
      deletedData: ['access_token', 'refresh_token'],
    }
  }

  cleanup(): void {
    this.oauthHandler?.cleanup()
  }
}
