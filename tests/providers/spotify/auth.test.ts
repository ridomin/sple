import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, platform } from 'node:os'
import createDebug from 'debug'
import { SpotifyAuth } from '../../../src/providers/spotify/auth.js'
import { loadTokens, saveTokens, type StoredToken } from '../../../src/core/config/token-store.js'
import {
  AccessRestrictedError,
  AuthRequiredError,
  ProviderError,
  RateLimitError,
} from '../../../src/core/provider/errors.js'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'
import { SPOTIFY_LOGIN_SCOPES } from '../../../src/providers/spotify/scopes.js'
import {
  mapApiError,
  PREMIUM_REQUIRED_MESSAGE,
  SPOTIFY_SETUP_DOCS_URL,
} from '../../../src/providers/spotify/errors.js'
import { handleLogin } from '../../../src/cli/commands/auth/login.js'
import { getExitCode, EXIT_CODES } from '../../../src/cli/exit-codes.js'
import type { LoginInteraction } from '../../../src/core/provider/provider.js'

const ACCESS = 'BQD-secret-access-token-value'
const REFRESH = 'AQA-secret-refresh-token-value'
const NEW_ACCESS = 'BQD-rotated-access-token-value'
const NEW_REFRESH = 'AQA-rotated-refresh-token-value'
const CODE = 'auth-code-secret-value'
const SECRETS = [ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH, CODE]

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

type Responder = (call: Call) => Response | Promise<Response>

const realFetch = globalThis.fetch
let calls: Call[]
let tempDir: string
let debugOutput: string[]
const realDebugLog = createDebug.log

function mockFetch(routes: Record<string, Responder>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    // Let real loopback requests (the simulated browser redirect) through.
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init)
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const route = routes[url]
    if (!route) throw new Error(`Unexpected fetch: ${url}`)
    return route(call)
  }) as typeof fetch
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const tokenOk = (extra: Record<string, unknown> = {}) => () =>
  json(200, {
    access_token: ACCESS,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: REFRESH,
    scope: 'playlist-read-private playlist-modify-private',
    ...extra,
  })

const meOk = () => json(200, { id: 'spotify-user-42', display_name: 'Ada Lovelace' })

/** Manual mode: captures the authorize URL, then "pastes" a redirect URL. */
function manualInteraction(redirect: (authUrl: URL) => string) {
  let authUrl: URL | undefined
  const interaction: LoginInteraction = {
    async showAuthorizationUrl(url) {
      authUrl = new URL(url)
    },
    async promptForRedirectUrl() {
      return redirect(authUrl!)
    },
  }
  return { interaction, getAuthUrl: () => authUrl! }
}

function storedToken(extra: Partial<StoredToken> = {}): StoredToken {
  return {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    scopes: ['playlist-read-private'],
    userId: 'spotify-user-42',
    displayName: 'Ada Lovelace',
    grantedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  }
}

beforeEach(() => {
  calls = []
  tempDir = mkdtempSync(join(tmpdir(), 'sple-spotify-auth-'))
  debugOutput = []
  createDebug.log = (...args: unknown[]) => {
    debugOutput.push(args.map(String).join(' '))
  }
  createDebug.enable('sple:*')
})

afterEach(() => {
  globalThis.fetch = realFetch
  createDebug.log = realDebugLog
  createDebug.disable()
  rmSync(tempDir, { recursive: true, force: true })
})

function assertNoSecretsLogged() {
  const all = debugOutput.join('\n')
  for (const s of SECRETS) assert.ok(!all.includes(s), `debug output leaked ${s}`)
}

test('login (manual): exchanges code, fetches /me, saves granted scopes', async () => {
  mockFetch({
    'https://accounts.spotify.com/api/token': tokenOk(),
    'https://api.spotify.com/v1/me': meOk,
  })
  const { interaction, getAuthUrl } = manualInteraction(
    (u) => `http://127.0.0.1/callback?code=${CODE}&state=${u.searchParams.get('state')}`
  )
  const auth = new SpotifyAuth('client-123', tempDir)
  const status = await auth.login({ mode: 'manual', scopes: [], interaction })

  assert.equal(status.loggedIn, true)
  assert.deepEqual(status.user, { id: 'spotify-user-42', displayName: 'Ada Lovelace' })
  assert.deepEqual(status.scopes, ['playlist-read-private', 'playlist-modify-private'])
  assert.ok(status.expiresAt)

  // Token request
  assert.equal(calls[0].url, 'https://accounts.spotify.com/api/token')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['content-type'], 'application/x-www-form-urlencoded')
  const form = new URLSearchParams(calls[0].body)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code'), CODE)
  assert.equal(form.get('client_id'), 'client-123')
  assert.equal(form.get('redirect_uri'), getAuthUrl().searchParams.get('redirect_uri'))
  assert.equal(form.get('redirect_uri'), 'http://127.0.0.1/callback')
  const verifier = form.get('code_verifier')!
  assert.ok(verifier.length >= 43)
  assert.equal(form.get('client_secret'), null)

  // /me request carries the new access token
  assert.equal(calls[1].url, 'https://api.spotify.com/v1/me')
  assert.equal(calls[1].headers.authorization, `Bearer ${ACCESS}`)

  // Persisted with real values and granted (not requested) scopes
  const saved = loadTokens('spotify', tempDir)!
  assert.equal(saved.accessToken, ACCESS)
  assert.equal(saved.refreshToken, REFRESH)
  assert.equal(saved.userId, 'spotify-user-42')
  assert.equal(saved.displayName, 'Ada Lovelace')
  assert.deepEqual(saved.scopes, ['playlist-read-private', 'playlist-modify-private'])
  assert.ok(saved.expiresAt && Date.parse(saved.expiresAt) > Date.now())
  if (platform() !== 'win32') {
    assert.equal(statSync(join(tempDir, 'tokens.json')).mode & 0o777, 0o600)
  }

  assertNoSecretsLogged()
  assert.ok(debugOutput.some((l) => l.includes('POST /api/token')), 'expected a token request log line')
})

test('login (no-browser): redirect_uri sent to /token is byte-identical to the loopback one', async () => {
  mockFetch({
    'https://accounts.spotify.com/api/token': tokenOk(),
    'https://api.spotify.com/v1/me': () => json(200, { id: 'u1', display_name: null }),
  })
  let authUrl: URL | undefined
  const interaction: LoginInteraction = {
    async showAuthorizationUrl(url) {
      authUrl = new URL(url)
      const redirect = authUrl.searchParams.get('redirect_uri')!
      // Simulate the browser following Spotify's redirect, after waiting starts
      setImmediate(() => {
        void fetch(`${redirect}?code=${CODE}&state=${authUrl!.searchParams.get('state')}`)
      })
    },
    async promptForRedirectUrl() {
      throw new Error('not used')
    },
  }
  const auth = new SpotifyAuth('client-123', tempDir)
  const status = await auth.login({ mode: 'no-browser', scopes: [], interaction })

  const form = new URLSearchParams(calls[0].body)
  assert.match(form.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  assert.equal(form.get('redirect_uri'), authUrl!.searchParams.get('redirect_uri'))
  assert.equal(status.user?.id, 'u1')
  assert.equal(loadTokens('spotify', tempDir)?.displayName, undefined)
})

test('login: error=access_denied in the redirect → ProviderError, no token request, nothing saved', async () => {
  mockFetch({})
  const { interaction } = manualInteraction(
    (u) => `http://127.0.0.1/callback?error=access_denied&state=${u.searchParams.get('state')}`
  )
  const auth = new SpotifyAuth('client-123', tempDir)
  await assert.rejects(
    auth.login({ mode: 'manual', scopes: [], interaction }),
    (err: unknown) => err instanceof ProviderError && /access_denied/.test((err as Error).message)
  )
  assert.equal(calls.length, 0)
  assert.equal(loadTokens('spotify', tempDir), null)
})

test('login: token endpoint 400 → ProviderError without body content, nothing saved', async () => {
  mockFetch({
    'https://accounts.spotify.com/api/token': () =>
      json(400, { error: 'invalid_request', error_description: `bad verifier ${CODE}` }),
  })
  const { interaction } = manualInteraction(
    (u) => `http://127.0.0.1/callback?code=${CODE}&state=${u.searchParams.get('state')}`
  )
  const auth = new SpotifyAuth('client-123', tempDir)
  await assert.rejects(auth.login({ mode: 'manual', scopes: [], interaction }), (err: unknown) => {
    assert.ok(err instanceof ProviderError)
    assert.ok(!(err instanceof AuthRequiredError))
    assert.match((err as Error).message, /HTTP 400, invalid_request/)
    assert.ok(!(err as Error).message.includes(CODE))
    assert.equal(getExitCode(err), EXIT_CODES.ERROR)
    return true
  })
  assert.equal(calls.length, 1)
  assert.equal(loadTokens('spotify', tempDir), null)
  assertNoSecretsLogged()
})

test('login: invalid_client → ProviderError naming the client ID setting', async () => {
  mockFetch({
    'https://accounts.spotify.com/api/token': () => json(400, { error: 'invalid_client' }),
  })
  const { interaction } = manualInteraction(
    (u) => `http://127.0.0.1/callback?code=${CODE}&state=${u.searchParams.get('state')}`
  )
  await assert.rejects(
    new SpotifyAuth('bad', tempDir).login({ mode: 'manual', scopes: [], interaction }),
    /SPLE_SPOTIFY_CLIENT_ID/
  )
})

test('login: /me 401 → AuthRequiredError, nothing saved', async () => {
  mockFetch({
    'https://accounts.spotify.com/api/token': tokenOk(),
    'https://api.spotify.com/v1/me': () => json(401, { error: { status: 401, message: 'nope' } }),
  })
  const { interaction } = manualInteraction(
    (u) => `http://127.0.0.1/callback?code=${CODE}&state=${u.searchParams.get('state')}`
  )
  await assert.rejects(
    new SpotifyAuth('client-123', tempDir).login({ mode: 'manual', scopes: [], interaction }),
    AuthRequiredError
  )
  assert.equal(loadTokens('spotify', tempDir), null)
})

test('refresh with rotation persists the new refresh token', async () => {
  saveTokens('spotify', storedToken(), tempDir)
  mockFetch({
    'https://accounts.spotify.com/api/token': () =>
      json(200, {
        access_token: NEW_ACCESS,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: NEW_REFRESH,
        scope: 'playlist-read-private',
      }),
  })
  const auth = new SpotifyAuth('client-123', tempDir)
  const refreshed = await auth.refresh(storedToken())

  const form = new URLSearchParams(calls[0].body)
  assert.equal(form.get('grant_type'), 'refresh_token')
  assert.equal(form.get('refresh_token'), REFRESH)
  assert.equal(form.get('client_id'), 'client-123')

  assert.equal(refreshed.accessToken, NEW_ACCESS)
  assert.equal(refreshed.refreshToken, NEW_REFRESH)
  assert.equal(refreshed.userId, 'spotify-user-42')
  assert.ok(Date.parse(refreshed.expiresAt!) > Date.now())
  const saved = loadTokens('spotify', tempDir)!
  assert.equal(saved.accessToken, NEW_ACCESS)
  assert.equal(saved.refreshToken, NEW_REFRESH)
  assertNoSecretsLogged()
})

test('refresh without rotation keeps the old refresh token and scopes', async () => {
  saveTokens('spotify', storedToken(), tempDir)
  mockFetch({
    'https://accounts.spotify.com/api/token': () =>
      json(200, { access_token: NEW_ACCESS, token_type: 'Bearer', expires_in: 3600 }),
  })
  const refreshed = await new SpotifyAuth('client-123', tempDir).refresh(storedToken())

  assert.equal(refreshed.accessToken, NEW_ACCESS)
  assert.equal(refreshed.refreshToken, REFRESH)
  assert.deepEqual(refreshed.scopes, ['playlist-read-private'])
  const saved = loadTokens('spotify', tempDir)!
  assert.equal(saved.accessToken, NEW_ACCESS)
  assert.equal(saved.refreshToken, REFRESH)
  assertNoSecretsLogged()
})

test('refresh: invalid_grant → AuthRequiredError(revoked), exit 3', async () => {
  mockFetch({
    'https://accounts.spotify.com/api/token': () =>
      json(400, { error: 'invalid_grant', error_description: `Refresh token revoked ${REFRESH}` }),
  })
  await assert.rejects(new SpotifyAuth('client-123', tempDir).refresh(storedToken()), (err: unknown) => {
    assert.ok(err instanceof AuthRequiredError)
    assert.equal(err.reason, 'revoked')
    assert.match(err.message, /run "sple auth login"/)
    assert.ok(!err.message.includes(REFRESH))
    assert.equal(getExitCode(err), EXIT_CODES.AUTH_REQUIRED)
    assert.equal(getExitCode(err), 3)
    return true
  })
  assertNoSecretsLogged()
})

test('refresh: no stored refresh token → AuthRequiredError without a request', async () => {
  mockFetch({})
  await assert.rejects(
    new SpotifyAuth('client-123', tempDir).refresh(storedToken({ refreshToken: undefined })),
    AuthRequiredError
  )
  assert.equal(calls.length, 0)
})

test('refresh: token endpoint 5xx and 429 map to closed error types', async () => {
  mockFetch({ 'https://accounts.spotify.com/api/token': () => new Response('oops', { status: 503 }) })
  await assert.rejects(new SpotifyAuth('c', tempDir).refresh(storedToken()), (err: unknown) => {
    assert.ok(err instanceof ProviderError)
    assert.match((err as Error).message, /HTTP 503/)
    return true
  })

  mockFetch({
    'https://accounts.spotify.com/api/token': () =>
      new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }),
  })
  await assert.rejects(new SpotifyAuth('c', tempDir).refresh(storedToken()), (err: unknown) => {
    assert.ok(err instanceof RateLimitError)
    assert.equal(err.retryAfterMs, 7000)
    return true
  })

  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  await assert.rejects(new SpotifyAuth('c', tempDir).refresh(storedToken()), ProviderError)
})

test('status and logout use the stored token', async () => {
  const auth = new SpotifyAuth('client-123', tempDir)
  assert.deepEqual(await auth.status(), { loggedIn: false, scopes: [] })

  saveTokens('spotify', storedToken(), tempDir)
  const status = await auth.status()
  assert.equal(status.loggedIn, true)
  assert.deepEqual(status.user, { id: 'spotify-user-42', displayName: 'Ada Lovelace' })

  const result = await auth.logout()
  assert.equal(result.revoked, false)
  assert.equal((await auth.status()).loggedIn, false)
  assert.ok(!readFileSync(join(tempDir, 'tokens.json'), 'utf-8').includes(ACCESS))
})

// ---- M1-11: scopes and Premium detection ----

test('login requests exactly the union of the M1 scope table', async () => {
  mockFetch({
    'https://accounts.spotify.com/api/token': tokenOk(),
    'https://api.spotify.com/v1/me': meOk,
  })
  const { interaction, getAuthUrl } = manualInteraction(
    (u) => `http://127.0.0.1/callback?code=${CODE}&state=${u.searchParams.get('state')}`
  )
  await new SpotifyAuth('client-123', tempDir).login({ mode: 'manual', scopes: [], interaction })
  const requested = getAuthUrl().searchParams.get('scope')!.split(' ').sort()
  assert.deepEqual(requested, [...SPOTIFY_LOGIN_SCOPES].sort())
  assert.deepEqual(requested, [
    'playlist-modify-private',
    'playlist-modify-public',
    'playlist-read-collaborative',
    'playlist-read-private',
    'user-library-read',
  ])
})

test('login: Premium error on /me (S4 fixture) → exit 1, documented message, no token saved', async () => {
  const fixture = readFileSync(
    new URL('../../fixtures/spotify/premium-required.json', import.meta.url),
    'utf-8'
  )
  mockFetch({
    'https://accounts.spotify.com/api/token': tokenOk(),
    'https://api.spotify.com/v1/me': () =>
      new Response(fixture, { status: 403, headers: { 'Content-Type': 'application/json' } }),
  })
  const { interaction } = manualInteraction(
    (u) => `http://127.0.0.1/callback?code=${CODE}&state=${u.searchParams.get('state')}`
  )
  const provider = createSpotifyProvider('client-123', tempDir)
  // Swap in the manual interaction while going through the CLI login handler.
  const login = provider.auth.login.bind(provider.auth)
  provider.auth.login = (opts) => login({ ...opts, mode: 'manual', interaction })

  const err: string[] = []
  const code = await handleLogin(provider, { out: () => {}, err: (m) => err.push(m) })
  assert.equal(code, EXIT_CODES.ERROR)
  assert.equal(err.length, 1)
  assert.match(err[0], /Spotify Premium is required/)
  assert.ok(err[0].includes(SPOTIFY_SETUP_DOCS_URL))
  assert.equal(loadTokens('spotify', tempDir), null)
  assert.throws(() => readFileSync(join(tempDir, 'tokens.json')), /ENOENT/)
  assertNoSecretsLogged()
})

test('mapApiError: Premium rule is 403 + /premium/i only', () => {
  const premium = mapApiError(403, null, JSON.stringify({ error: { status: 403, message: 'PREMIUM_REQUIRED' } }))
  assert.ok(premium instanceof AccessRestrictedError)
  assert.equal(premium.reason, 'premium-required')
  assert.equal(premium.message, PREMIUM_REQUIRED_MESSAGE)

  const other = mapApiError(403, null, JSON.stringify({ error: { status: 403, message: 'Forbidden' } }))
  assert.ok(other instanceof AccessRestrictedError)
  assert.equal(other.reason, 'other')
  // Body text never leaks into the message.
  assert.ok(!other.message.includes('Forbidden'))

  assert.equal((mapApiError(403, null, 'not json') as AccessRestrictedError).reason, 'other')
  assert.equal((mapApiError(403) as AccessRestrictedError).reason, 'other')
  // A non-403 mentioning Premium is not the Premium rule.
  assert.ok(!(mapApiError(400, null, JSON.stringify({ error: { message: 'premium' } })) instanceof AccessRestrictedError))
})

test('logout returns a notice with the account Apps page URL', async () => {
  saveTokens('spotify', storedToken(), tempDir)
  const result = await new SpotifyAuth('client-123', tempDir).logout()
  assert.equal(result.revoked, false)
  assert.match(result.notice ?? '', /no revoke endpoint/)
  assert.ok(result.notice?.includes('https://www.spotify.com/account/apps/'))
})
