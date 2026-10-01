import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { URL } from 'node:url'
import type { OAuthConfig } from '../../../src/core/auth/auth.js'
import { LoopbackServer, OAuthHandler } from '../../../src/core/auth/oauth-handler.js'

test('LoopbackServer', async (t) => {
  await t.test('binds to localhost on a random port', async () => {
    const server = new LoopbackServer()
    try {
      const baseUrl = await server.start()
      assert.match(baseUrl, /^http:\/\/localhost:\d+\/$/)
    } finally {
      server.stop()
    }
  })

  await t.test('accepts redirect with valid state and code', async () => {
    const server = new LoopbackServer()
    try {
      await server.start()

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
    } finally {
      server.stop()
    }
  })

  await t.test('rejects redirect with mismatched state', async () => {
    const server = new LoopbackServer()
    try {
      await server.start()

      let redirectError: Error | null = null
      server.waitForRedirect({ state: 'correct-state' })
        .catch(err => { redirectError = err })

      const url = new URL(server.baseUrl)
      url.searchParams.set('code', 'auth-code-xyz')
      url.searchParams.set('state', 'wrong-state')

      const response = await fetch(url.toString())
      assert.equal(response.status, 400)

      // Give promise time to settle
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(redirectError)
      assert.match(redirectError!.message, /State validation failed/)
    } finally {
      server.stop()
    }
  })

  await t.test('rejects redirect with error parameter', async () => {
    const server = new LoopbackServer()
    try {
      await server.start()

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
    } finally {
      server.stop()
    }
  })

  await t.test('rejects redirect with mismatched host (DNS rebinding)', async () => {
    const server = new LoopbackServer()
    try {
      await server.start()

      let redirectError: Error | null = null
      server.waitForRedirect({ state: 'test-state' })
        .catch(err => { redirectError = err })

      // Extract hostname and port from baseUrl
      const baseUrlObj = new URL(server.baseUrl)
      const hostname = baseUrlObj.hostname
      const port = baseUrlObj.port

      // Make direct HTTP request with mismatched Host header
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            hostname,
            port: Number(port),
            path: '/?code=auth-code-xyz&state=test-state',
            method: 'GET',
            headers: { 'Host': 'attacker.com:' + port }
          },
          (res) => {
            let statusCode = 0
            res.on('data', () => {
              // ignore
            })
            res.on('end', () => {
              statusCode = res.statusCode || 0
              assert.equal(statusCode, 400)
              resolve()
            })
            res.on('error', reject)
          }
        )
        req.on('error', reject)
        req.end()
      })

      // Handler should not be called for invalid host
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(redirectError, null)
    } finally {
      server.stop()
    }
  })
})

test('OAuthHandler', async (t) => {
  const config: OAuthConfig = { clientId: 'test-client-id', scopes: ['playlist-read-private', 'user-read-email'] }
  const endpoint = 'https://provider.com/oauth/authorize'

  await t.test('loopback login builds a full authorization URL', async () => {
    const handler = new OAuthHandler(config, endpoint)
    try {
      const login = await handler.initiateLogin('loopback')
      const u = new URL(login.authorizationUrl)
      assert.equal(u.origin + u.pathname, endpoint)
      assert.equal(u.searchParams.get('client_id'), 'test-client-id')
      assert.equal(u.searchParams.get('response_type'), 'code')
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
      assert.ok(u.searchParams.get('code_challenge'))
      assert.equal(u.searchParams.get('state'), login.state)
      assert.equal(u.searchParams.get('scope'), 'playlist-read-private user-read-email')
      assert.equal(u.searchParams.get('redirect_uri'), login.redirectUri)
      assert.match(login.redirectUri!, /^http:\/\/localhost:\d+\/$/)
      assert.match(login.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/)
    } finally {
      handler.cleanup()
    }
  })

  await t.test('no-browser and manual login have no loopback redirect', async () => {
    const handler = new OAuthHandler(config, endpoint)
    for (const mode of ['no-browser', 'manual'] as const) {
      const login = await handler.initiateLogin(mode)
      assert.equal(login.redirectUri, undefined)
      assert.equal(new URL(login.authorizationUrl).searchParams.get('code_challenge_method'), 'S256')
    }
  })

  await t.test('state is random per login', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const a = await handler.initiateLogin('manual')
    const b = await handler.initiateLogin('manual')
    assert.notEqual(a.state, b.state)
    assert.notEqual(a.codeVerifier, b.codeVerifier)
  })

  await t.test('completes loopback login via redirect', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const login = await handler.initiateLogin('loopback')
    const done = handler.completeLogin(login)
    await new Promise(r => setTimeout(r, 20))
    const res = await fetch(`${login.redirectUri}?code=test-code&state=${login.state}`)
    assert.equal(res.status, 200)
    const result = await done
    assert.deepEqual(result, { code: 'test-code', state: login.state, codeVerifier: login.codeVerifier })
  })

  await t.test('loopback rejects mismatched state', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const login = await handler.initiateLogin('loopback')
    const done = handler.completeLogin(login)
    const assertion = assert.rejects(done, /State validation failed/)
    await new Promise(r => setTimeout(r, 20))
    await fetch(`${login.redirectUri}?code=x&state=wrong`)
    await assertion
  })

  await t.test('manual login trims whitespace around pasted URL', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const login = await handler.initiateLogin('manual')
    const result = await handler.completeLogin(login, {
      userProvidedUrl: `  http://localhost:3000/?code=manual-code&state=${login.state}  \n`,
    })
    assert.equal(result.code, 'manual-code')
    assert.equal(result.codeVerifier, login.codeVerifier)
  })

  await t.test('manual login rejects state mismatch, missing code, error, and garbage', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const login = await handler.initiateLogin('manual')
    await assert.rejects(handler.completeLogin(login, { userProvidedUrl: 'http://localhost/?code=c&state=bad' }), /State mismatch/)
    await assert.rejects(handler.completeLogin(login, { userProvidedUrl: `http://localhost/?state=${login.state}` }), /missing code/)
    await assert.rejects(handler.completeLogin(login, { userProvidedUrl: `http://localhost/?error=access_denied&state=${login.state}` }), /access_denied/)
    await assert.rejects(handler.completeLogin(login, { userProvidedUrl: 'not a url' }), /Invalid redirect URL/)
  })

  await t.test('uses userInput callback when no URL or server', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const login = await handler.initiateLogin('no-browser')
    let prompted = ''
    const result = await handler.completeLogin(login, {
      userInput: async (p) => {
        prompted = p
        return ` http://x/?code=input-code&state=${login.state} `
      },
    })
    assert.ok(prompted)
    assert.equal(result.code, 'input-code')
  })

  await t.test('throws when no completion source is available', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const login = await handler.initiateLogin('manual')
    await assert.rejects(handler.completeLogin(login), /requires/)
  })

  await t.test('cleanup stops the loopback server and is idempotent', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const login = await handler.initiateLogin('loopback')
    handler.cleanup()
    handler.cleanup()
    await assert.rejects(fetch(`${login.redirectUri}?code=a&state=b`))
  })
})
