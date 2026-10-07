/**
 * Auth contract shared by every real OAuth provider (#75). Each provider
 * registers a subject in auth-contract.test.ts; the cases below then run
 * against all of them, so scope handling cannot drift between providers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AuthRequiredError } from '../../src/core/provider/errors.js'
import { loadTokens, saveTokens, type StoredToken } from '../../src/core/config/token-store.js'
import type { LoginInteraction, ProviderAuth } from '../../src/core/provider/provider.js'
import type { ProviderId } from '../../src/core/provider/capabilities.js'

/** The OAuth surface beyond ProviderAuth that both real providers implement. */
export interface ContractAuth extends ProviderAuth {
  refresh(token: StoredToken): Promise<StoredToken>
  requireScopes(required: readonly string[]): Promise<StoredToken>
}

export interface AuthContractSubject {
  name: string
  providerId: ProviderId
  create(configDir: string): ContractAuth
  /** Scopes the adapter requests at login by default. */
  requestedScopes: readonly string[]
  tokenUrl: string
  identityUrl: string
  /** Identity endpoint body for a successful login. */
  identityBody: Record<string, unknown>
}

const freshDir = () => mkdtempSync(join(tmpdir(), 'sple-auth-contract-'))

const tokenResponse = (scope?: string) => ({
  access_token: 'access-1',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'refresh-1',
  ...(scope === undefined ? {} : { scope }),
})

/** Run `fn` with fetch answering only the subject's token and identity endpoints. */
async function withFetch<T>(
  s: AuthContractSubject,
  tokenBody: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === s.tokenUrl) return Response.json(tokenBody)
    if (url === s.identityUrl) return Response.json(s.identityBody)
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

/** Manual-mode interaction that "pastes" a redirect carrying the expected state. */
function pastingInteraction(): LoginInteraction {
  let authorizationUrl = ''
  return {
    async showAuthorizationUrl(url) { authorizationUrl = url },
    promptForRedirectUrl: async () =>
      `http://127.0.0.1/callback?code=contract-code&state=${new URL(authorizationUrl).searchParams.get('state')}`,
  }
}

function login(s: AuthContractSubject, auth: ContractAuth, tokenBody: Record<string, unknown>) {
  return withFetch(s, tokenBody, () => auth.login({ mode: 'manual', scopes: [], interaction: pastingInteraction() }))
}

function storedToken(scopes: string[]): StoredToken {
  return {
    accessToken: 'stored-access',
    refreshToken: 'stored-refresh',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scopes,
    userId: 'contract-user',
    grantedAt: new Date().toISOString(),
  }
}

export function runAuthContract(s: AuthContractSubject): void {
  const requested = [...s.requestedScopes]
  // A partial grant: the user declined the first requested scope.
  const [declined, ...granted] = requested

  test(`${s.name} auth contract`, async (t) => {
    assert.ok(granted.length > 0, 'the contract needs at least two requested scopes')

    await t.test('login stores and reports the granted scopes, listing the declined ones as missing', async () => {
      const dir = freshDir()
      const status = await login(s, s.create(dir), tokenResponse(granted.join(' ')))

      assert.deepStrictEqual(status.scopes, granted)
      assert.deepStrictEqual(status.missingScopes, [declined])
      assert.deepStrictEqual(loadTokens(s.providerId, dir)?.scopes, granted)
    })

    await t.test('login with every scope granted reports none missing', async () => {
      const status = await login(s, s.create(freshDir()), tokenResponse(requested.join(' ')))

      assert.deepStrictEqual(status.scopes, requested)
      assert.deepStrictEqual(status.missingScopes, [])
    })

    await t.test('login treats an absent scope field as the requested scopes (RFC 6749 §5.1)', async () => {
      const dir = freshDir()
      const status = await login(s, s.create(dir), tokenResponse())

      assert.deepStrictEqual(loadTokens(s.providerId, dir)?.scopes, requested)
      assert.deepStrictEqual(status.missingScopes, [])
    })

    await t.test('refresh replaces the stored scopes with the granted ones', async () => {
      const dir = freshDir()
      const updated = await withFetch(s, tokenResponse(granted.join(' ')), () =>
        s.create(dir).refresh(storedToken(requested))
      )

      assert.deepStrictEqual(updated.scopes, granted)
      assert.deepStrictEqual(loadTokens(s.providerId, dir)?.scopes, granted)
    })

    await t.test('refresh without a scope field keeps the stored scopes', async () => {
      const updated = await withFetch(s, tokenResponse(), () =>
        s.create(freshDir()).refresh(storedToken(granted))
      )

      assert.deepStrictEqual(updated.scopes, granted)
    })

    await t.test('requireScopes throws missing-scope naming a scope that was not granted', async () => {
      const dir = freshDir()
      saveTokens(s.providerId, storedToken(granted), dir)

      await assert.rejects(
        () => s.create(dir).requireScopes([declined]),
        (e: unknown) => e instanceof AuthRequiredError && e.reason === 'missing-scope' && e.scope === declined
      )
    })

    await t.test('requireScopes returns the token when every required scope was granted', async () => {
      const dir = freshDir()
      saveTokens(s.providerId, storedToken(requested), dir)

      const token = await s.create(dir).requireScopes(requested)
      assert.equal(token.accessToken, 'stored-access')
    })

    await t.test('requireScopes without a stored token throws no-token', async () => {
      await assert.rejects(
        () => s.create(freshDir()).requireScopes([declined]),
        (e: unknown) => e instanceof AuthRequiredError && e.reason === 'no-token'
      )
    })
  })
}
