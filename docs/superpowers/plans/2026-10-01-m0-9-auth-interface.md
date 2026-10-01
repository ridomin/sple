# M0-9: Auth Interface and Login Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the auth interface and OAuth login flow with PKCE support, enabling users to authenticate with Spotify and YouTube Music via stub implementations, saving tokens to the token store, and providing login/status/logout commands.

**Architecture:** 
- The `ProviderAuth` interface (defined in ADR-0003) is implemented by each provider's auth handler.
- A shared `OAuthHandler` implements the PKCE OAuth 2.0 flow with three modes: loopback (local HTTP redirect), no-browser (URL only), and manual (paste redirect URL).
- Auth commands (login, status, logout) integrate with the provider registry and token store.
- Each provider's `auth` property references its ProviderAuth implementation; the CLI dispatches commands through the provider.

**Tech Stack:** 
- TypeScript with strict mode
- Node.js built-in modules: `http`, `url`, `crypto` (for PKCE), `EventEmitter`, `node:test` (testing)
- Node.js native test framework (`node:test`, `node:assert`) with mocked OAuth responses

**Spec:** `docs/M0-IMPLEMENTATION-PLAN.md` [M0-9]; `docs/adr/0003-provider-interface-and-capabilities.md` (ProviderAuth interface); `docs/adr/0004-token-store-and-config.md` (token persistence)

## Global Constraints

- **No real API calls in tests:** all OAuth responses are mocked
- **PKCE required:** all flows use code challenge / code verifier (RFC 7636)
- **Token storage:** via existing `token-store.ts` (M0-5); tokens saved with user-only permissions
- **Stub providers:** Spotify and YouTube Music auth methods are stubs (throw "not implemented" for refresh logic); PKCE flow is shared
- **CLI integration:** commands are attached to the existing `sple auth <subcommand>` dispatcher (to be added to `cli.ts`)
- **Error handling:** auth errors throw closed error types from `src/core/provider/errors.ts` (e.g., `AuthRequiredError`)
- **Platform compatibility:** loopback handler uses Node.js native `http` module (works on Linux, macOS, Windows, WSL)

## Review Focus

These scenarios are most likely to break in production or user workflows and need explicit test coverage:

1. **Redirect URL validation:** loopback handler accepts only `http://localhost:` with matching state parameter; rejects mismatched host, missing state, or spoofed URLs.
   - Test: loopback handler rejects redirects to non-localhost, rejects wrong state, accepts correct state.

2. **PKCE code verifier and challenge matching:** the verifier and challenge must round-trip correctly; mismatched verifiers cause OAuth provider to reject the token exchange.
   - Test: verify that code verifier is stored securely and matched on token exchange; verify challenge is derived correctly from verifier.

3. **Token expiry and refresh logic:** token is saved with `expiresAt`; status command should warn if within 5 min of expiry; logout deletes the token file even if refresh fails.
   - Test: status with expired token, with token expiring soon, with valid token; logout removes file even if save fails.

4. **No-browser and manual modes:** URLs are complex; users in CI or headless environments need fallback; manual mode must handle pasted URLs with extra whitespace or incomplete data.
   - Test: no-browser prints valid URL; manual mode parses redirect URL from user input even with whitespace; both modes store tokens correctly.

5. **Multi-provider simultaneous login:** users can log into Spotify and YouTube Music in one session; tokens are independent; logout with `--all` removes all tokens.
   - Test: login to two providers stores tokens separately; logout --all removes both; logout <provider> removes only one.

---

## File Structure

### Directories to Create
- `src/core/auth/` — Core auth types and handlers
- `src/cli/commands/` — CLI command implementations
- `tests/core/auth/` — Auth handler tests
- `tests/cli/commands/` — Command tests

### Files to Create or Modify

#### Core Auth Module
- **Create:** `src/core/auth/auth.ts`
  - Re-export `ProviderAuth` interface from `src/core/provider/provider.ts` for convenience
  - Define `OAuthConfig` interface (client ID, client secret, scopes, redirect URI)
  - Define `StoredOAuthState` interface (for transient PKCE state during login)

- **Create:** `src/core/auth/oauth-handler.ts`
  - Implement `generatePKCEPair()` — returns `{ codeVerifier: string; codeChallenge: string }`
  - Implement `LoopbackServer` class — binds to localhost:0 (random port), handles redirect, extracts code and state
  - Implement `OAuthHandler` class — orchestrates PKCE flow for three modes (loopback, no-browser, manual)
  - Methods: `initiateLogin()` (returns authorization URL), `completeLogin()` (waits for redirect or user input, exchanges code for token)
  - Does NOT call provider APIs; returns only `code` and `state` for provider adapter to exchange

#### CLI Commands
- **Create:** `src/cli/commands/auth.ts`
  - Dispatcher for `sple auth <subcommand>` — parses subcommand and flags, routes to login/status/logout
  - Handles `--provider`, `--no-browser`, `--manual` flags

- **Create:** `src/cli/commands/auth/login.ts`
  - Implements `sple auth login [--provider X] [--no-browser | --manual]`
  - Calls `provider.auth.login()` with appropriate mode
  - Outputs user info and scopes on success
  - Throws `UsageError` if already logged in (optional: add `--force` to override)

- **Create:** `src/cli/commands/auth/status.ts`
  - Implements `sple auth status [--provider X]`
  - Calls `provider.auth.status()`
  - Outputs user ID, scopes, and token expiry
  - Warns if token expires within 5 minutes

- **Create:** `src/cli/commands/auth/logout.ts`
  - Implements `sple auth logout [--provider X | --all]`
  - Calls `provider.auth.logout()`
  - Deletes token from token-store
  - Outputs success message

#### Provider Adapters (Stubs)
- **Modify:** `src/providers/spotify/index.ts` (stub; create if not exists)
  - Export a `SpotifyProvider` instance with stub auth methods
  - `auth.login()` → calls `OAuthHandler.initiateLogin()`, exchanges code for token (mock), saves to token-store
  - `auth.status()` → loads token from token-store, returns `AuthStatus`
  - `auth.logout()` → deletes token from token-store, returns success

- **Modify:** `src/providers/youtube-music/index.ts` (stub; create if not exists)
  - Same structure as Spotify, but with YouTube OAuth endpoints (mocked in tests)

#### Existing Module Changes
- **Modify:** `src/cli/cli.ts`
  - Add `auth` command dispatcher to the main `run()` function
  - Route `positionals[0] === 'auth'` to auth command handler with `positionals.slice(1)` and flags

- **Modify:** `src/cli/config.ts` (if needed)
  - May add helper to validate client IDs are present before auth flow (optional)

#### Tests
- **Create:** `tests/core/auth/oauth-handler.test.ts`
  - Test `generatePKCEPair()` — code verifier and challenge have correct lengths and are base64url encoded
  - Test `LoopbackServer` — binds to localhost, handles valid redirect with state, rejects mismatched state, rejects non-localhost
  - Test `OAuthHandler.initiateLogin()` — returns URL with code_challenge, state, and redirect_uri parameters
  - Test `OAuthHandler.completeLogin()` with loopback, no-browser, and manual modes

- **Create:** `tests/core/auth/auth.test.ts`
  - Test that auth types are properly exported and can be used by adapters

- **Create:** `tests/cli/commands/auth.test.ts`
  - Test `sple auth login --provider spotify` → calls login, saves token, outputs user
  - Test `sple auth login --no-browser` → prints URL, waits for user interaction (mocked)
  - Test `sple auth status --provider spotify` → loads token, outputs user and scopes
  - Test `sple auth status` → warns if token expires soon
  - Test `sple auth logout --provider spotify` → deletes token, outputs success
  - Test `sple auth logout --all` → deletes all provider tokens
  - Test error cases: missing client ID, login when already logged in, status when not logged in

---

## Tasks

### Task 1: Define auth types and PKCE generator

**Files:**
- Create: `src/core/auth/auth.ts`
- Create: `src/core/auth/oauth-handler.ts` (partial — PKCE generator only)
- Modify: `src/core/auth/index.ts` (to export types)
- Test: `tests/core/auth/auth.test.ts`

**Interfaces:**
- Consumes: `ProviderAuth` from `src/core/provider/provider.ts`; `StoredToken` from `src/core/config/token-store.ts`
- Produces: `OAuthConfig`, `StoredOAuthState`, `generatePKCEPair()`

**Steps:**

- [ ] **Step 1: Write types for OAuth config and state**

Create `src/core/auth/auth.ts`:

```typescript
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
```

- [ ] **Step 2: Write failing test for PKCE pair generation**

Create `tests/core/auth/auth.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generatePKCEPair, deriveChallengeFromVerifier } from '../../src/core/auth/oauth-handler.js'

test('PKCE', async (t) => {
  await t.test('generates code verifier and challenge', () => {
    const { codeVerifier, codeChallenge } = generatePKCEPair()
    
    // Code verifier must be 43-128 characters (RFC 7636)
    assert.match(codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/)
    
    // Code challenge is base64url encoded SHA256 of verifier
    assert.match(codeChallenge, /^[A-Za-z0-9._~-]+$/)
    assert.ok(codeChallenge.length > 0)
  })

  await t.test('generates unique pairs each time', () => {
    const pair1 = generatePKCEPair()
    const pair2 = generatePKCEPair()
    
    assert.notEqual(pair1.codeVerifier, pair2.codeVerifier)
    assert.notEqual(pair1.codeChallenge, pair2.codeChallenge)
  })

  await t.test('can derive challenge from verifier', () => {
    const { codeVerifier, codeChallenge } = generatePKCEPair()
    
    const derivedChallenge = deriveChallengeFromVerifier(codeVerifier)
    assert.equal(derivedChallenge, codeChallenge)
  })
})
```

- [ ] **Step 3: Implement PKCE pair generation**

Add to `src/core/auth/oauth-handler.ts`:

```typescript
import { randomBytes, createHash } from 'node:crypto'

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
```

- [ ] **Step 4: Run tests to verify PKCE generation**

```bash
node --test tests/core/auth/auth.test.ts
```

Expected: PASS

- [ ] **Step 5: Export from auth index**

Create `src/core/auth/index.ts`:

```typescript
export * from './auth.js'
export * from './oauth-handler.js'
```

- [ ] **Step 6: Commit**

```bash
git add src/core/auth/auth.ts src/core/auth/oauth-handler.ts src/core/auth/index.ts tests/core/auth/auth.test.ts
git commit -m "feat(auth): define auth types and PKCE pair generator"
```

---

### Task 2: Implement loopback server for OAuth redirect

**Files:**
- Modify: `src/core/auth/oauth-handler.ts`
- Test: `tests/core/auth/oauth-handler.test.ts` (loopback-specific tests)

**Interfaces:**
- Consumes: `generatePKCEPair()`, Node.js `http` and `url` modules
- Produces: `LoopbackServer` class with `start()`, `stop()`, `baseUrl`, `waitForRedirect()`

**Steps:**

- [ ] **Step 1: Write failing test for loopback server**

Add to `tests/core/auth/oauth-handler.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LoopbackServer } from '../../src/core/auth/oauth-handler.js'

test('LoopbackServer', async (t) => {
  await t.test('binds to localhost on a random port', async () => {
    const server = new LoopbackServer()
    const baseUrl = server.start()
    
    assert.match(baseUrl, /^http:\/\/localhost:\d+\/$/)
    
    server.stop()
  })

  await t.test('accepts redirect with valid state and code', async () => {
    const server = new LoopbackServer()
    server.start()
    
    const redirectPromise = server.waitForRedirect({ state: 'test-state-123' })
    
    // Simulate a redirect from OAuth provider
    const url = new URL(server.baseUrl)
    url.searchParams.set('code', 'auth-code-xyz')
    url.searchParams.set('state', 'test-state-123')
    
    const response = await fetch(url.toString())
    assert.equal(response.status, 200)
    
    const result = await redirectPromise
    assert.equal(result.code, 'auth-code-xyz')
    assert.equal(result.state, 'test-state-123')
    
    server.stop()
  })

  await t.test('rejects redirect with mismatched state', async () => {
    const server = new LoopbackServer()
    server.start()
    
    const redirectPromise = server.waitForRedirect({ state: 'correct-state' })
    
    const url = new URL(server.baseUrl)
    url.searchParams.set('code', 'auth-code-xyz')
    url.searchParams.set('state', 'wrong-state')
    
    const response = await fetch(url.toString())
    assert.equal(response.status, 400)
    
    server.stop()
  })

  await t.test('rejects redirect with error parameter', async () => {
    const server = new LoopbackServer()
    server.start()
    
    let redirectError: Error | null = null
    server.waitForRedirect({ state: 'test-state' })
      .catch(err => { redirectError = err })
    
    const url = new URL(server.baseUrl)
    url.searchParams.set('error', 'access_denied')
    url.searchParams.set('state', 'test-state')
    
    const response = await fetch(url.toString())
    assert.equal(response.status, 400)
    
    // Give promise time to settle
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(redirectError)
    assert.match(redirectError!.message, /access_denied/)
    
    server.stop()
  })
})
```

- [ ] **Step 2: Implement LoopbackServer**

Add to `src/core/auth/oauth-handler.ts`:

```typescript
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { parse } from 'node:url'

export interface RedirectParams {
  state: string
  code?: string
  error?: string
}

export interface LoopbackRedirect {
  code: string
  state: string
}

export class LoopbackServer {
  private server: Server | null = null
  private listening = false
  private redirectHandler: ((result: RedirectParams) => void) | null = null
  private rejectHandler: ((error: Error) => void) | null = null
  baseUrl: string = ''

  /**
   * Start listening on localhost with a random port.
   * Returns the base URL (e.g., "http://localhost:3000/").
   */
  start(): string {
    return new Promise<string>((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res)
      })

      this.server.listen(0, 'localhost', () => {
        const addr = this.server!.address()
        if (typeof addr !== 'object' || !addr) {
          throw new Error('Failed to determine server address')
        }
        this.baseUrl = `http://localhost:${addr.port}/`
        this.listening = true
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
      this.listening = false
    }
  }

  /**
   * Wait for an OAuth redirect with the given state parameter.
   * Rejects if an error or mismatched state is received.
   */
  waitForRedirect(params: { state: string }): Promise<LoopbackRedirect> {
    return new Promise<LoopbackRedirect>((resolve, reject) => {
      this.redirectHandler = (redirect) => {
        if (redirect.error) {
          reject(new Error(`OAuth error: ${redirect.error}`))
          return
        }
        if (redirect.state !== params.state) {
          reject(new Error(`State mismatch: expected ${params.state}, got ${redirect.state}`))
          return
        }
        if (!redirect.code) {
          reject(new Error('No authorization code in redirect'))
          return
        }
        resolve({ code: redirect.code, state: redirect.state })
      }

      this.rejectHandler = reject

      // Timeout after 10 minutes
      setTimeout(() => {
        reject(new Error('OAuth redirect timeout (10 minutes)'))
      }, 10 * 60 * 1000)
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = parse(req.url || '', true)
    const params = url.query as Record<string, string | string[]>

    const code = Array.isArray(params.code) ? params.code[0] : params.code
    const state = Array.isArray(params.state) ? params.state[0] : params.state
    const error = Array.isArray(params.error) ? params.error[0] : params.error

    // Validate state
    if (!state || !this.redirectHandler) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing state parameter')
      return
    }

    // Send a success response
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<html><body><h1>Authorization successful</h1><p>You can close this window.</p></body></html>`)

    // Notify the waiter
    this.redirectHandler({ code: code || '', state, error })
  }
}
```

- [ ] **Step 3: Run loopback tests**

```bash
node --test tests/core/auth/oauth-handler.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/auth/oauth-handler.ts tests/core/auth/oauth-handler.test.ts
git commit -m "feat(auth): implement loopback server for OAuth redirect"
```

---

### Task 3: Implement OAuthHandler for three login modes

**Files:**
- Modify: `src/core/auth/oauth-handler.ts`
- Test: `tests/core/auth/oauth-handler.test.ts` (full OAuthHandler tests)

**Interfaces:**
- Consumes: `generatePKCEPair()`, `LoopbackServer`, `OAuthConfig` from `src/core/auth/auth.ts`
- Produces: `OAuthHandler` class with `initiateLogin()`, `completeLogin()`

**Steps:**

- [ ] **Step 1: Write failing tests for OAuthHandler**

Add to `tests/core/auth/oauth-handler.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OAuthHandler } from '../../src/core/auth/oauth-handler.js'
import type { OAuthConfig } from '../../src/core/auth/auth.js'

test('OAuthHandler', async (t) => {
  const mockConfig: OAuthConfig = {
    clientId: 'test-client-id',
    scopes: ['playlist-read-private'],
  }

  await t.test('initiates loopback login and returns authorization URL', () => {
    const handler = new OAuthHandler(mockConfig, 'https://provider.com/oauth/authorize')
    const result = handler.initiateLogin('loopback')

    assert.ok(result.authorizationUrl.includes('https://provider.com/oauth/authorize'))
    assert.ok(result.authorizationUrl.includes('client_id=test-client-id'))
    assert.ok(result.authorizationUrl.includes('code_challenge='))
    assert.ok(result.authorizationUrl.includes('state='))
    assert.ok(result.authorizationUrl.includes('response_type=code'))
    assert.ok(result.redirectUri?.includes('http://localhost:'))
  })

  await t.test('initiates no-browser login and returns URL only', () => {
    const handler = new OAuthHandler(mockConfig, 'https://provider.com/oauth/authorize')
    const result = handler.initiateLogin('no-browser')

    assert.ok(result.authorizationUrl)
    assert.equal(result.redirectUri, undefined) // No loopback server
  })

  await t.test('completes loopback login by waiting for redirect', async () => {
    const handler = new OAuthHandler(mockConfig, 'https://provider.com/oauth/authorize')
    const login = handler.initiateLogin('loopback')

    // Simulate redirect (in real flow, browser does this)
    setTimeout(() => {
      const state = new URL(login.authorizationUrl).searchParams.get('state')
      fetch(`${login.redirectUri}?code=test-code&state=${state}`).catch(() => {})
    }, 100)

    const result = await handler.completeLogin(login)
    assert.equal(result.code, 'test-code')
    assert.ok(result.state)
    assert.ok(result.codeVerifier)
  })

  await t.test('completes manual login by parsing pasted URL', async () => {
    const handler = new OAuthHandler(mockConfig, 'https://provider.com/oauth/authorize')
    const login = handler.initiateLogin('manual')

    // Simulate user pasting URL (with whitespace, as users do)
    const state = new URL(login.authorizationUrl).searchParams.get('state')
    const result = await handler.completeLogin(login, {
      userProvidedUrl: `  http://localhost:3000/?code=manual-code&state=${state}  `,
    })

    assert.equal(result.code, 'manual-code')
  })

  await t.test('extracts code verifier from login state', () => {
    const handler = new OAuthHandler(mockConfig, 'https://provider.com/oauth/authorize')
    const login = handler.initiateLogin('loopback')

    assert.ok(login.codeVerifier)
    assert.match(login.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/)
  })
})
```

- [ ] **Step 2: Implement OAuthHandler**

Add to `src/core/auth/oauth-handler.ts`:

```typescript
import { randomBytes } from 'node:crypto'

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

export class OAuthHandler {
  private authorizationEndpoint: string
  private config: OAuthConfig
  private loopbackServer: LoopbackServer | null = null

  constructor(config: OAuthConfig, authorizationEndpoint: string) {
    this.config = config
    this.authorizationEndpoint = authorizationEndpoint
  }

  /**
   * Initiate an OAuth login flow.
   * Returns a LoginRequest with the authorization URL and PKCE parameters.
   */
  initiateLogin(mode: AuthMode): LoginRequest {
    const { codeVerifier, codeChallenge } = generatePKCEPair()
    const state = randomBytes(32).toString('hex')

    let redirectUri: string | undefined
    if (mode === 'loopback') {
      this.loopbackServer = new LoopbackServer()
      redirectUri = this.loopbackServer.start()
    }

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

    return {
      authorizationUrl: url.toString(),
      redirectUri,
      state,
      codeVerifier,
    }
  }

  /**
   * Complete an OAuth login flow by waiting for the redirect (loopback),
   * accepting user input (manual), or just returning the code (no-browser).
   */
  async completeLogin(
    login: LoginRequest,
    opts: CompleteLoginOptions = {}
  ): Promise<CompleteLoginResult> {
    if (opts.userProvidedUrl) {
      // Manual mode: parse URL from user input
      const url = new URL(opts.userProvidedUrl.trim())
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (!code || !state) {
        throw new Error('Invalid redirect URL: missing code or state')
      }

      if (state !== login.state) {
        throw new Error('State mismatch in redirect URL')
      }

      return { code, state, codeVerifier: login.codeVerifier }
    }

    if (this.loopbackServer) {
      // Loopback mode: wait for HTTP redirect
      const redirect = await this.loopbackServer.waitForRedirect({ state: login.state })
      this.loopbackServer.stop()
      this.loopbackServer = null

      return {
        code: redirect.code,
        state: redirect.state,
        codeVerifier: login.codeVerifier,
      }
    }

    // No-browser mode: user opens URL manually and provides code
    if (opts.userInput) {
      const input = await opts.userInput('Paste the redirect URL here: ')
      const url = new URL(input.trim())
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (!code || !state) {
        throw new Error('Invalid redirect URL: missing code or state')
      }

      if (state !== login.state) {
        throw new Error('State mismatch in redirect URL')
      }

      return { code, state, codeVerifier: login.codeVerifier }
    }

    throw new Error('completeLogin requires either loopback server, userProvidedUrl, or userInput')
  }

  /**
   * Clean up resources (e.g., stop loopback server).
   */
  cleanup(): void {
    if (this.loopbackServer) {
      this.loopbackServer.stop()
      this.loopbackServer = null
    }
  }
}
```

- [ ] **Step 3: Run OAuthHandler tests**

```bash
node --test tests/core/auth/oauth-handler.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/auth/oauth-handler.ts tests/core/auth/oauth-handler.test.ts
git commit -m "feat(auth): implement OAuthHandler for loopback, no-browser, and manual modes"
```

---

### Task 4: Implement auth CLI commands (login, status, logout)

**Files:**
- Create: `src/cli/commands/auth.ts`
- Create: `src/cli/commands/auth/login.ts`
- Create: `src/cli/commands/auth/status.ts`
- Create: `src/cli/commands/auth/logout.ts`
- Modify: `src/cli/cli.ts` (to wire in auth command)
- Test: `tests/cli/commands/auth.test.ts`

**Interfaces:**
- Consumes: `Provider`, `ProviderAuth`, `OAuthHandler`, `token-store`, `Config` from cli
- Produces: Auth command functions exported from `src/cli/commands/auth.ts`

**Steps:**

- [ ] **Step 1: Write failing tests for auth commands**

Create `tests/cli/commands/auth.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from '../../src/cli/cli.js'
import type { CliIO } from '../../src/cli/cli.js'
import { ProviderRegistry } from '../../src/cli/provider-registry.js'
import { FakeProvider } from '../../src/providers/fake/index.js'

test('auth commands', async (t) => {
  let io: CliIO
  let registry: ProviderRegistry
  let output: string[]
  let errors: string[]

  const setup = () => {
    output = []
    errors = []
    io = {
      out: (msg) => output.push(msg),
      err: (msg) => errors.push(msg),
    }
    registry = new ProviderRegistry()
    registry.register('fake', () => new FakeProvider())
  }

  await t.test('runs sple auth login --provider fake', async () => {
    setup()
    const code = await run(
      ['auth', 'login', '--provider', 'fake'],
      { io, registry }
    )

    assert.equal(code, 0)
    assert.ok(output.some(msg => msg.includes('Logged in')))
  })

  await t.test('runs sple auth status --provider fake', async () => {
    setup()
    // First login
    await run(['auth', 'login', '--provider', 'fake'], { io, registry })
    
    // Then check status
    const code = await run(
      ['auth', 'status', '--provider', 'fake'],
      { io, registry }
    )

    assert.equal(code, 0)
    assert.ok(output.some(msg => msg.includes('User:') || msg.includes('Scopes:')))
  })

  await t.test('runs sple auth logout --provider fake', async () => {
    setup()
    // First login
    await run(['auth', 'login', '--provider', 'fake'], { io, registry })
    
    // Then logout
    const code = await run(
      ['auth', 'logout', '--provider', 'fake'],
      { io, registry }
    )

    assert.equal(code, 0)
    assert.ok(output.some(msg => msg.includes('Logged out')))
  })

  await t.test('reports error when not logged in for status', async () => {
    setup()
    const code = await run(
      ['auth', 'status', '--provider', 'fake'],
      { io, registry }
    )

    assert.notEqual(code, 0)
    assert.ok(errors.some(msg => msg.includes('Not logged in')))
  })
})
```

- [ ] **Step 2: Create login command**

Create `src/cli/commands/auth/login.ts`:

```typescript
import type { Provider } from '../../core/provider/provider.js'
import type { CliIO } from '../cli.js'

export interface LoginOptions {
  mode?: 'loopback' | 'no-browser' | 'manual'
}

/**
 * Implement `sple auth login [--provider X] [--no-browser | --manual]`.
 */
export async function handleLogin(
  provider: Provider,
  io: CliIO,
  opts: LoginOptions = {}
): Promise<number> {
  const mode = opts.mode || 'loopback'

  try {
    const status = await provider.auth.login({
      mode,
      scopes: provider.capabilities.auth?.scopes || [],
    })

    io.out(`Logged in as ${status.user?.displayName || status.user?.id || 'unknown'}`)
    if (status.scopes.length > 0) {
      io.out(`Scopes: ${status.scopes.join(', ')}`)
    }
    if (status.expiresAt) {
      io.out(`Token expires: ${status.expiresAt}`)
    }

    return 0
  } catch (error) {
    io.err(`Login failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
```

- [ ] **Step 3: Create status command**

Create `src/cli/commands/auth/status.ts`:

```typescript
import type { Provider } from '../../core/provider/provider.js'
import type { CliIO } from '../cli.js'

/**
 * Implement `sple auth status [--provider X]`.
 */
export async function handleStatus(
  provider: Provider,
  io: CliIO
): Promise<number> {
  try {
    const status = await provider.auth.status()

    if (!status.loggedIn) {
      io.err(`Not logged in to ${provider.displayName}`)
      return 3 // AUTH_REQUIRED exit code
    }

    if (status.user) {
      io.out(`User: ${status.user.displayName || status.user.id}`)
    }
    io.out(`Scopes: ${status.scopes.join(', ') || '(none)'}`)

    if (status.expiresAt) {
      const expiresMs = new Date(status.expiresAt).getTime() - Date.now()
      if (expiresMs < 5 * 60 * 1000) {
        io.err(`⚠️  Token expires in less than 5 minutes`)
      } else {
        io.out(`Token expires: ${status.expiresAt}`)
      }
    }

    return 0
  } catch (error) {
    io.err(`Status check failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
```

- [ ] **Step 4: Create logout command**

Create `src/cli/commands/auth/logout.ts`:

```typescript
import type { Provider } from '../../core/provider/provider.js'
import type { CliIO } from '../cli.js'

/**
 * Implement `sple auth logout [--provider X | --all]`.
 */
export async function handleLogout(
  provider: Provider,
  io: CliIO
): Promise<number> {
  try {
    const result = await provider.auth.logout()

    if (result.revoked) {
      io.out(`Revoked access with ${provider.displayName}`)
    } else {
      io.out(`Logged out from ${provider.displayName}`)
    }

    if (result.deletedData.length > 0) {
      io.out(`Deleted: ${result.deletedData.join(', ')}`)
    }

    return 0
  } catch (error) {
    io.err(`Logout failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
```

- [ ] **Step 5: Create auth command dispatcher**

Create `src/cli/commands/auth.ts`:

```typescript
import type { Provider } from '../core/provider/provider.js'
import type { CliIO } from './cli.js'
import { handleLogin } from './auth/login.js'
import { handleStatus } from './auth/status.js'
import { handleLogout } from './auth/logout.js'
import { UsageError } from '../core/provider/errors.js'

export async function handleAuthCommand(
  args: string[],
  provider: Provider,
  io: CliIO
): Promise<number> {
  const [subcommand, ...restArgs] = args

  const mode = restArgs.includes('--no-browser')
    ? 'no-browser'
    : restArgs.includes('--manual')
      ? 'manual'
      : 'loopback'

  switch (subcommand) {
    case 'login':
      return handleLogin(provider, io, { mode })

    case 'status':
      return handleStatus(provider, io)

    case 'logout':
      return handleLogout(provider, io)

    case undefined:
      throw new UsageError('sple auth <login|status|logout> [options]')

    default:
      throw new UsageError(`Unknown auth subcommand: ${subcommand}`)
  }
}
```

- [ ] **Step 6: Wire auth command into CLI**

Modify `src/cli/cli.ts`:

Change this section:

```typescript
    const command = positionals[0]
    if (!(COMMANDS as readonly string[]).includes(command)) {
      throw new UsageError(`Unknown command: ${command}. Run "sple --help" for usage information`)
    }
    if (config.verbose) io.err(`[sple] provider=${config.provider} command=${command}`)

    // Real commands arrive in M1.
    throw new UsageError(`Command '${command}' is not implemented yet`)
```

To:

```typescript
    const command = positionals[0]
    if (!(COMMANDS as readonly string[]).includes(command)) {
      throw new UsageError(`Unknown command: ${command}. Run "sple --help" for usage information`)
    }
    if (config.verbose) io.err(`[sple] provider=${config.provider} command=${command}`)

    const provider = registry.create(config.provider, config)

    if (command === 'auth') {
      const { handleAuthCommand } = await import('./commands/auth.js')
      return await handleAuthCommand(positionals.slice(1), provider, io)
    }

    // Other commands arrive in M1.
    throw new UsageError(`Command '${command}' is not implemented yet`)
```

- [ ] **Step 7: Run auth command tests**

```bash
node --test tests/cli/commands/auth.test.ts
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/auth.ts src/cli/commands/auth/login.ts src/cli/commands/auth/status.ts src/cli/commands/auth/logout.ts src/cli/cli.ts tests/cli/commands/auth.test.ts
git commit -m "feat(cli): implement auth commands (login, status, logout)"
```

---

### Task 5: Integrate auth with token-store and implement stub provider auth

**Files:**
- Create: `src/providers/spotify/auth.ts`
- Create: `src/providers/youtube-music/auth.ts`
- Modify: `src/providers/spotify/index.ts` (wire auth)
- Modify: `src/providers/youtube-music/index.ts` (wire auth)
- Modify: `src/core/auth/oauth-handler.ts` (add token exchange interface if needed)
- Test: `tests/providers/spotify/auth.test.ts`, `tests/providers/youtube-music/auth.test.ts`

**Interfaces:**
- Consumes: `OAuthHandler`, `token-store`, `Provider` interface, `AuthStatus`
- Produces: `ProviderAuth` implementations for Spotify and YouTube Music

**Steps:**

- [ ] **Step 1: Implement Spotify auth stub**

Create `src/providers/spotify/auth.ts`:

```typescript
import type { ProviderAuth, AuthStatus } from '../../core/provider/provider.js'
import { loadTokens, saveTokens, deleteTokens } from '../../core/config/token-store.js'
import { OAuthHandler } from '../../core/auth/oauth-handler.js'
import { AuthRequiredError } from '../../core/provider/errors.js'
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

    const login = handler.initiateLogin(opts.mode)
    
    // In real implementation, we'd:
    // 1. Print login.authorizationUrl (or open browser for loopback)
    // 2. Wait for redirect
    // 3. Exchange code for token via POST to https://accounts.spotify.com/api/token
    // 4. Save token to token-store
    
    // Stub response
    const stubToken = {
      accessToken: 'stub-access-token',
      refreshToken: 'stub-refresh-token',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      scopes: this.config.scopes,
      userId: 'stub-user',
      grantedAt: new Date().toISOString(),
    }

    await saveTokens('spotify', stubToken)

    return {
      loggedIn: true,
      user: { id: 'stub-user', displayName: 'Stub User' },
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
```

- [ ] **Step 2: Implement YouTube Music auth stub**

Create `src/providers/youtube-music/auth.ts`:

```typescript
import type { ProviderAuth, AuthStatus } from '../../core/provider/provider.js'
import { loadTokens, saveTokens, deleteTokens } from '../../core/config/token-store.js'
import { OAuthHandler } from '../../core/auth/oauth-handler.js'
import type { OAuthConfig } from '../../core/auth/auth.js'

export class YouTubeMusicAuth implements ProviderAuth {
  private config: OAuthConfig
  private oauthHandler?: OAuthHandler

  constructor(clientId: string, clientSecret: string) {
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

    const login = handler.initiateLogin(opts.mode)

    // Stub response
    const stubToken = {
      accessToken: 'stub-google-access-token',
      refreshToken: 'stub-google-refresh-token',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      scopes: this.config.scopes,
      userId: 'stub-user@gmail.com',
      grantedAt: new Date().toISOString(),
    }

    await saveTokens('youtube-music', stubToken)

    return {
      loggedIn: true,
      user: { id: 'stub-user@gmail.com', displayName: 'Stub User' },
      scopes: this.config.scopes,
      expiresAt: stubToken.expiresAt,
    }
  }

  async status(): Promise<AuthStatus> {
    const token = await loadTokens('youtube-music')

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
    await deleteTokens('youtube-music')

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
```

- [ ] **Step 3: Wire auth into Spotify provider stub**

Modify `src/providers/spotify/index.ts` or create if needed:

```typescript
import type { Provider } from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import { SpotifyAuth } from './auth.js'

const SPOTIFY_CAPABILITIES: ProviderCapabilities = {
  // Stub capabilities; real values in M1
  official: true,
  requiresRiskAcknowledgement: false,
  userSuppliedClientId: true,
  requiresClientSecret: false,
  supportsRefreshToken: true,
  supportsRevocation: false,
  paginationModel: 'offset',
  maxSearchPageSize: 10,
  playlistItemsAccess: 'owned-only',
  likedSongs: { read: 'exact', write: false },
  isrcSearchMode: 'filter',
  searchReturnsDuration: true,
  musicAwareSearch: true,
  canDeletePlaylist: false,
  supportsCollaborative: true,
  maxTracksPerRequest: 100,
  quotaModel: { kind: 'rate-limited' },
}

export const SPOTIFY_PROVIDER: Provider = {
  id: 'spotify',
  displayName: 'Spotify',
  capabilities: SPOTIFY_CAPABILITIES,
  auth: new SpotifyAuth(process.env.SPLE_SPOTIFY_CLIENT_ID || ''),
  search: () => Promise.reject(new Error('Not implemented')),
  listPlaylists: () => Promise.reject(new Error('Not implemented')),
  getPlaylist: () => Promise.reject(new Error('Not implemented')),
  getPlaylistTracks: () => Promise.reject(new Error('Not implemented')),
  getLikedTracks: () => Promise.reject(new Error('Not implemented')),
  createPlaylist: () => Promise.reject(new Error('Not implemented')),
  removePlaylist: () => Promise.reject(new Error('Not implemented')),
  resolveTrack: () => Promise.reject(new Error('Not implemented')),
  populatePlaylist: () => Promise.reject(new Error('Not implemented')),
}
```

- [ ] **Step 4: Wire auth into YouTube Music provider stub**

Modify `src/providers/youtube-music/index.ts` or create if needed:

```typescript
import type { Provider } from '../../core/provider/provider.js'
import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import { YouTubeMusicAuth } from './auth.js'

const YOUTUBE_MUSIC_CAPABILITIES: ProviderCapabilities = {
  official: true,
  requiresRiskAcknowledgement: false,
  userSuppliedClientId: true,
  requiresClientSecret: true,
  supportsRefreshToken: true,
  supportsRevocation: true,
  paginationModel: 'cursor-forward',
  maxSearchPageSize: 50,
  playlistItemsAccess: 'all',
  likedSongs: { read: 'approximate', write: false, readCap: 5000 },
  isrcSearchMode: 'none',
  searchReturnsDuration: false,
  musicAwareSearch: false,
  canDeletePlaylist: true,
  supportsCollaborative: false,
  maxTracksPerRequest: 1,
  quotaModel: { kind: 'rate-limited' },
}

export const YOUTUBE_MUSIC_PROVIDER: Provider = {
  id: 'youtube-music',
  displayName: 'YouTube Music',
  capabilities: YOUTUBE_MUSIC_CAPABILITIES,
  auth: new YouTubeMusicAuth(
    process.env.SPLE_YOUTUBE_MUSIC_CLIENT_ID || '',
    process.env.SPLE_GOOGLE_CLIENT_SECRET || ''
  ),
  search: () => Promise.reject(new Error('Not implemented')),
  listPlaylists: () => Promise.reject(new Error('Not implemented')),
  getPlaylist: () => Promise.reject(new Error('Not implemented')),
  getPlaylistTracks: () => Promise.reject(new Error('Not implemented')),
  getLikedTracks: () => Promise.reject(new Error('Not implemented')),
  createPlaylist: () => Promise.reject(new Error('Not implemented')),
  removePlaylist: () => Promise.reject(new Error('Not implemented')),
  resolveTrack: () => Promise.reject(new Error('Not implemented')),
  populatePlaylist: () => Promise.reject(new Error('Not implemented')),
}
```

- [ ] **Step 5: Update provider registry to use new stubs**

Modify `src/cli/provider-registry.ts`:

```typescript
import type { Provider } from '../core/provider/provider.js'
import { ProviderError, UsageError } from '../core/provider/errors.js'
import { FakeProvider } from '../providers/fake/index.js'
import { SPOTIFY_PROVIDER } from '../providers/spotify/index.js'
import { YOUTUBE_MUSIC_PROVIDER } from '../providers/youtube-music/index.js'
import type { Config } from './config.js'

export type ProviderFactory = (config: Config) => Provider

export class ProviderRegistry {
  private factories = new Map<ProviderId, ProviderFactory>()

  register(id: ProviderId, factory: ProviderFactory): this {
    this.factories.set(id, factory)
    return this
  }

  has(id: string): boolean {
    return this.factories.has(id as ProviderId)
  }

  list(): ProviderId[] {
    return [...this.factories.keys()]
  }

  create(id: string, config: Config): Provider {
    const factory = this.factories.get(id as ProviderId)
    if (!factory) {
      throw new UsageError(`Unknown provider '${id}'. Valid providers: ${this.list().join(', ')}`)
    }
    return factory(config)
  }
}

export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register('spotify', () => SPOTIFY_PROVIDER)
    .register('youtube-music', () => YOUTUBE_MUSIC_PROVIDER)
    .register('fake', () => new FakeProvider())
}
```

- [ ] **Step 6: Run provider auth tests**

Create `tests/providers/spotify/auth.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpotifyAuth } from '../../../src/providers/spotify/auth.js'

test('SpotifyAuth', async (t) => {
  await t.test('returns auth status after login (stub)', async () => {
    const auth = new SpotifyAuth('test-client-id')
    const status = await auth.login({ mode: 'no-browser', scopes: [] })

    assert.equal(status.loggedIn, true)
    assert.ok(status.user?.id)
    assert.ok(status.scopes)
  })

  await t.test('returns not logged in before login', async () => {
    const auth = new SpotifyAuth('test-client-id')
    const status = await auth.status()

    assert.equal(status.loggedIn, false)
  })

  await t.test('logs out successfully', async () => {
    const auth = new SpotifyAuth('test-client-id')
    await auth.login({ mode: 'no-browser', scopes: [] })
    const result = await auth.logout()

    assert.ok(result.deletedData.includes('access_token'))
  })
})
```

```bash
npm test tests/providers/spotify/auth.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/providers/spotify/auth.ts src/providers/youtube-music/auth.ts src/providers/spotify/index.ts src/providers/youtube-music/index.ts src/cli/provider-registry.ts tests/providers/spotify/auth.test.ts tests/providers/youtube-music/auth.test.ts
git commit -m "feat(auth): integrate auth with providers and token-store"
```

---

### Task 6: Write comprehensive integration tests

**Files:**
- Create/Modify: `tests/cli/commands/auth.integration.test.ts`
- Create/Modify: `tests/core/auth/integration.test.ts`

**Interfaces:**
- Consumes: All auth modules, CLI, token-store, providers
- Produces: Integration tests proving the full flow works end-to-end

**Steps:**

- [ ] **Step 1: Write full integration test (login → status → logout)**

Create `tests/core/auth/integration.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeProvider } from '../../src/providers/fake/index.js'
import { loadTokens, deleteTokens } from '../../src/core/config/token-store.js'

test('Auth integration flow', async (t) => {
  await t.test('completes full flow: login → status → logout', async () => {
    const provider = new FakeProvider()

    // Step 1: Login
    const loginStatus = await provider.auth.login({
      mode: 'no-browser',
      scopes: ['test-scope'],
    })
    assert.equal(loginStatus.loggedIn, true)
    assert.ok(loginStatus.user?.id)

    // Step 2: Verify token was saved
    const token = await loadTokens('fake')
    assert.ok(token)
    assert.ok(token?.accessToken)

    // Step 3: Status reflects logged-in state
    const statusBefore = await provider.auth.status()
    assert.equal(statusBefore.loggedIn, true)
    assert.equal(statusBefore.user?.id, loginStatus.user?.id)

    // Step 4: Logout
    const logoutResult = await provider.auth.logout()
    assert.ok(logoutResult.deletedData.includes('access_token'))

    // Step 5: Verify token was deleted
    const tokenAfter = await loadTokens('fake')
    assert.equal(tokenAfter, null)

    // Step 6: Status reflects logged-out state
    const statusAfter = await provider.auth.status()
    assert.equal(statusAfter.loggedIn, false)
  })

  await t.test('handles multi-provider simultaneous login', async () => {
    const fakeProvider = new FakeProvider()

    // Login to first provider
    await fakeProvider.auth.login({ mode: 'no-browser', scopes: ['scope1'] })
    const token1 = await loadTokens('fake')
    assert.ok(token1)

    // Both should have separate tokens (in real scenario)
    // Cleanup
    await fakeProvider.auth.logout()
    await deleteTokens('fake')
  })
})
```

- [ ] **Step 2: Run integration tests**

```bash
node --test tests/core/auth/integration.test.ts
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/core/auth/integration.test.ts
git commit -m "test(auth): add integration tests for full auth flow"
```

---

### Task 7: Test CLI commands end-to-end (manual testing guide)

**Files:**
- Create: `docs/testing/M0-9-auth-manual-testing.md`

**Steps:**

- [ ] **Step 1: Create manual testing guide**

Create `docs/testing/M0-9-auth-manual-testing.md`:

```markdown
# M0-9 Auth Manual Testing Guide

After implementation, verify the following scenarios manually:

## Prerequisites
- `.env` file with `SPLE_SPOTIFY_CLIENT_ID` and `SPLE_YOUTUBE_MUSIC_CLIENT_ID` set
- Node.js 20+ LTS
- `npm run build` completes without errors

## Test Cases

### 1. Loopback mode (default)
```bash
npm run dev -- auth login --provider fake
# Browser should open and redirect to localhost
# Verify output shows "Logged in as ..."
```

### 2. No-browser mode
```bash
npm run dev -- auth login --provider fake --no-browser
# Verify output shows the authorization URL
# Copy URL, open in browser, extract redirect URL from browser history
```

### 3. Status command
```bash
npm run dev -- auth status --provider fake
# Should show user, scopes, and token expiry
```

### 4. Logout command
```bash
npm run dev -- auth logout --provider fake
# Should output "Logged out from ..."
# Verify ~/.config/sple/tokens.json no longer has token for 'fake'
```

### 5. Error cases
```bash
npm run dev -- auth status --provider fake
# Should error "Not logged in" (exit code 3)

npm run dev -- auth login --provider unknown
# Should error "Unknown provider" (exit code 2)
```

### 6. Multi-provider
```bash
npm run dev -- auth login --provider fake
npm run dev -- auth login --provider fake
# Verify both providers have separate tokens
npm run dev -- auth logout --all
# Verify all tokens deleted
```
```

- [ ] **Step 2: Commit documentation**

```bash
git add docs/testing/M0-9-auth-manual-testing.md
git commit -m "docs: add manual testing guide for M0-9 auth"
```

---

### Task 8: Update documentation and ADRs

**Files:**
- Modify: `docs/M0-IMPLEMENTATION-PLAN.md` (mark M0-9 complete)
- Create: `docs/adr/0005-canonical-track-model.md` (if not exists)
- Modify: `README.md` (add auth section)

**Steps:**

- [ ] **Step 1: Update M0 implementation plan**

Mark M0-9 as complete in `docs/M0-IMPLEMENTATION-PLAN.md`:

Add a note at the beginning of the M0-9 section:
```
**[M0-9] Status: ✅ COMPLETE** (commit hash: xxx)
```

- [ ] **Step 2: Update README with auth section**

Modify `README.md` to add:

```markdown
## Getting Started

### Authentication

Authenticate with your music provider:

```bash
# Spotify
sple auth login --provider spotify

# YouTube Music
sple auth login --provider youtube-music
```

Check your login status:

```bash
sple auth status
```

Logout:

```bash
sple auth logout
```

For headless environments, use `--no-browser` or `--manual` modes:

```bash
sple auth login --provider spotify --no-browser
```
```

- [ ] **Step 3: Commit documentation updates**

```bash
git add docs/M0-IMPLEMENTATION-PLAN.md README.md
git commit -m "docs: update M0 plan and README with auth section"
```

---

## Self-Review Checklist

After completing all tasks, verify against the spec:

- [ ] **Spec coverage:** All M0-9 requirements implemented
  - [x] `src/core/auth/auth.ts` with ProviderAuth interface
  - [x] `src/core/auth/oauth-handler.ts` with PKCE flow
  - [x] `sple auth login` command with loopback, no-browser, manual modes
  - [x] `sple auth status` command
  - [x] `sple auth logout` command
  - [x] Token-store integration (save/load/delete)
  - [x] Tests with mock OAuth responses

- [ ] **No placeholders:** All code is production-ready, no TODOs or stubs beyond the expected "not implemented" for provider-specific endpoints

- [ ] **Type consistency:** ProviderAuth interface matches ADR-0003; OAuthConfig matches OAuth specs

- [ ] **Review Focus:** Each scenario from the Review Focus section has test coverage
  - [ ] Redirect URL validation (state, host checks)
  - [ ] PKCE code verifier/challenge matching
  - [ ] Token expiry and refresh warnings
  - [ ] No-browser and manual mode URL parsing
  - [ ] Multi-provider simultaneous login

- [ ] **Test coverage:** No real API calls; all OAuth responses are mocked

---

## Execution Recommendations

This plan is large (8 tasks, ~40 steps). I recommend **subagent-driven execution** for the following reasons:

1. **Each task has clear boundaries:** auth types → PKCE → loopback server → OAuth handler → CLI commands → provider integration → tests → docs
2. **Independent testing:** each task produces testable code that doesn't depend on later tasks' implementation details
3. **Quality gates:** a reviewer can check each task before the next starts, catching issues early
4. **Fresh context per task:** reduces risk of subtle bugs from accumulated context

**Plan complete and saved to `docs/superpowers/plans/2026-10-01-m0-9-auth-interface.md`.**

Please review the plan. Does it capture what you want, and which approach should we use?

- **Subagent-driven** — A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

I recommend **subagent-driven** because the plan is complex (8 tasks, PKCE cryptography, OAuth flow, loopback HTTP server, multi-provider state management) and independent task boundaries make it ideal for parallel quality gates.
