import { randomBytes, createHash } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'

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
   * Rejects if an error is present, state is missing, state doesn't match,
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

        // Check for error parameter
        if (redirect.error) {
          reject(new Error(`OAuth error: ${redirect.error}`))
          return
        }

        // Check state matches
        if (redirect.state !== params.state) {
          reject(new Error(`State mismatch: expected ${params.state}, got ${redirect.state}`))
          return
        }

        // Check code is present
        if (!redirect.code) {
          reject(new Error('No authorization code in redirect'))
          return
        }

        resolve({ code: redirect.code, state: redirect.state })
      }

      // Timeout after 10 minutes (RFC 6234 recommends 10 minute timeout)
      this.timeoutId = setTimeout(() => {
        this.redirectHandler = null
        this.expectedState = null
        this.timeoutId = null
        reject(new Error('OAuth redirect timeout (10 minutes)'))
      }, 10 * 60 * 1000)
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
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

    // If there's an error parameter, return 400 and notify handler
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end(`OAuth error: ${error}`)
      this.redirectHandler({ state, error })
      return
    }

    // If state doesn't match expected, return 400 and notify handler
    if (state !== this.expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('State mismatch')
      this.redirectHandler({ state, code: code || '' })
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

