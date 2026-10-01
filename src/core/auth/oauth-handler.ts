import { randomBytes, createHash } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { OAuthConfig } from './auth.js'

/**
 * Generate a PKCE code verifier and challenge (RFC 7636).
 * The verifier is random 43-128 characters; the challenge is base64url(sha256(verifier)).
 */
export function generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
  // Generate 32 random bytes → 43 base64url characters (RFC 7636 recommends 43-128)
  const codeVerifier = randomBytes(32)
    .toString('base64url')

  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url')

  return { codeVerifier, codeChallenge }
}

export function deriveChallengeFromVerifier(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64url')
}

/**
 * Parameters received in OAuth redirect.
 */
export interface RedirectParams {
  state: string
  code?: string
  error?: string
}

/**
 * Result returned when OAuth redirect is successfully received and validated.
 */
export interface LoopbackRedirect {
  code: string
  state: string
}

/**
 * Loopback server for capturing OAuth redirects.
 * Binds to localhost:0 (random port) and waits for authorization code redirect.
 */
export class LoopbackServer {
  private server: Server | null = null
  private redirectHandler: ((result: RedirectParams) => void) | null = null
  private expectedState: string | null = null
  private timeoutId: NodeJS.Timeout | null = null
  baseUrl: string = ''

  /**
   * Start listening on localhost with a random port.
   * Returns a promise that resolves with the base URL (e.g., "http://localhost:3000/").
   */
  start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res)
      })

      this.server.listen(0, 'localhost', () => {
        const addr = this.server!.address()
        if (typeof addr !== 'object' || !addr) {
          reject(new Error('Failed to determine server address'))
          return
        }
        this.baseUrl = `http://localhost:${addr.port}/`
        resolve(this.baseUrl)
      })

      this.server.on('error', reject)
    })
  }

  /**
   * Stop the server and clean up.
   */
  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
  }

  /**
   * Wait for an OAuth redirect with the given state parameter.
   * Rejects if state is missing, state doesn't match, error is present,
   * or no code is provided.
   * Times out after 10 minutes.
   */
  waitForRedirect(params: { state: string }): Promise<LoopbackRedirect> {
    return new Promise<LoopbackRedirect>((resolve, reject) => {
      this.expectedState = params.state
      this.redirectHandler = (redirect) => {
        // Clear timeout when redirect received
        if (this.timeoutId) {
          clearTimeout(this.timeoutId)
          this.timeoutId = null
        }

        // Check state matches first (before error check)
        if (redirect.state !== params.state) {
          this.redirectHandler = null
          this.expectedState = null
          reject(new Error('State validation failed'))
          return
        }

        // Check for error parameter
        if (redirect.error) {
          this.redirectHandler = null
          this.expectedState = null
          reject(new Error(`OAuth error: ${redirect.error}`))
          return
        }

        // Check code is present
        if (!redirect.code) {
          this.redirectHandler = null
          this.expectedState = null
          reject(new Error('No authorization code in redirect'))
          return
        }

        // Success: resolve and clean up
        this.redirectHandler = null
        this.expectedState = null
        resolve({ code: redirect.code, state: redirect.state })
      }

      // Timeout after 10 minutes
      this.timeoutId = setTimeout(() => {
        this.redirectHandler = null
        this.expectedState = null
        this.timeoutId = null
        reject(new Error('OAuth redirect timeout (10 minutes)'))
      }, 10 * 60 * 1000)
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Validate Host header to prevent DNS rebinding attacks
    const hostHeader = req.headers.host
    if (!hostHeader) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing Host header')
      return
    }

    // Extract port from baseUrl for comparison
    const baseUrlPort = this.baseUrl.match(/:(\d+)\/$/)?.[1]
    const expectedHosts = [
      `localhost:${baseUrlPort}`,
      `127.0.0.1:${baseUrlPort}`
    ]

    if (!expectedHosts.includes(hostHeader)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Invalid host')
      return
    }

    // Parse the request URL using WHATWG URL API
    const urlPath = req.url || ''
    const url = new URL(urlPath, this.baseUrl)
    const params = url.searchParams

    const code = params.get('code') || undefined
    const state = params.get('state') || undefined
    const error = params.get('error') || undefined

    // Validate that state is present
    if (!state) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing state parameter')
      return
    }

    // Check if we have a handler waiting for a redirect
    if (!this.redirectHandler) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('No redirect handler registered')
      return
    }

    // Validate state before checking error (prevents request cancellation)
    if (state !== this.expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Invalid state')
      this.redirectHandler({ state, code: code || '' })
      return
    }

    // If there's an error parameter, return 400 and notify handler
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end(`OAuth error: ${error}`)
      this.redirectHandler({ state, error })
      return
    }

    // If code is missing, return 400 and notify handler
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing authorization code')
      this.redirectHandler({ state, code: '' })
      return
    }

    // Send success response
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><body><h1>Authorization successful</h1><p>You can close this window.</p></body></html>')

    // Notify the waiter
    this.redirectHandler({ code, state })
  }
}

export type AuthMode = 'loopback' | 'no-browser' | 'manual'

export interface LoginRequest {
  authorizationUrl: string
  redirectUri?: string
  state: string
  codeVerifier: string
}

export interface CompleteLoginOptions {
  userProvidedUrl?: string
  userInput?: (prompt: string) => Promise<string>
}

export interface CompleteLoginResult {
  code: string
  state: string
  codeVerifier: string
}

/**
 * Orchestrates PKCE OAuth 2.0 authorization-code flows (loopback, no-browser, manual).
 * Does not exchange the code for tokens; the provider does that using the
 * returned code and codeVerifier.
 */
export class OAuthHandler {
  private loopbackServer: LoopbackServer | null = null

  constructor(
    private readonly config: OAuthConfig,
    private readonly authorizationEndpoint: string
  ) {}

  /**
   * Begin a login flow. In loopback mode this starts the loopback server
   * (async because binding a port is async); call cleanup() or completeLogin()
   * to release it.
   */
  async initiateLogin(mode: AuthMode): Promise<LoginRequest> {
    // Release any server left over from a previous initiation
    this.cleanup()

    const { codeVerifier, codeChallenge } = generatePKCEPair()
    const state = randomBytes(32).toString('hex')

    let redirectUri: string | undefined = this.config.redirectUri
    if (mode === 'loopback') {
      const server = new LoopbackServer()
      redirectUri = await server.start()
      this.loopbackServer = server
    }

    return {
      authorizationUrl: this.buildAuthorizationUrl(codeChallenge, state, redirectUri),
      redirectUri,
      state,
      codeVerifier,
    }
  }

  /**
   * Complete a login flow. Sources of the redirect, in priority order:
   * userProvidedUrl, the loopback server, then the userInput callback.
   */
  async completeLogin(
    login: LoginRequest,
    opts: CompleteLoginOptions = {}
  ): Promise<CompleteLoginResult> {
    try {
      if (opts.userProvidedUrl !== undefined) {
        return this.parseRedirectUrl(opts.userProvidedUrl, login)
      }

      if (this.loopbackServer) {
        const redirect = await this.loopbackServer.waitForRedirect({ state: login.state })
        return { code: redirect.code, state: redirect.state, codeVerifier: login.codeVerifier }
      }

      if (opts.userInput) {
        const input = await opts.userInput('Paste the redirect URL here: ')
        return this.parseRedirectUrl(input, login)
      }

      throw new Error('completeLogin requires a loopback server, userProvidedUrl, or userInput')
    } finally {
      this.cleanup()
    }
  }

  /** Stop the loopback server if running. */
  cleanup(): void {
    if (this.loopbackServer) {
      this.loopbackServer.stop()
      this.loopbackServer = null
    }
  }

  private buildAuthorizationUrl(codeChallenge: string, state: string, redirectUri?: string): string {
    const url = new URL(this.authorizationEndpoint)
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    url.searchParams.set('scope', this.config.scopes.join(' '))
    if (redirectUri) {
      url.searchParams.set('redirect_uri', redirectUri)
    }
    return url.toString()
  }

  private parseRedirectUrl(raw: string, login: LoginRequest): CompleteLoginResult {
    let url: URL
    try {
      url = new URL(raw.trim())
    } catch {
      throw new Error('Invalid redirect URL')
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')

    if (state !== login.state) {
      throw new Error('State mismatch in redirect URL')
    }
    if (error) {
      throw new Error(`OAuth error: ${error}`)
    }
    if (!code) {
      throw new Error('Invalid redirect URL: missing code')
    }
    return { code, state, codeVerifier: login.codeVerifier }
  }
}
