import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { URL } from 'node:url'
import type { LoginInteraction, LoginMode } from '../../../src/core/provider/provider.js'
import type { OAuthConfig } from '../../../src/core/auth/auth.js'
import { LoopbackServer, OAuthHandler, MANUAL_REDIRECT_URI } from '../../../src/core/auth/oauth-handler.js'

/** Raw GET with an explicit Host header (fetch does not allow overriding Host). */
function rawGet(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

const tick = () => new Promise(resolve => setTimeout(resolve, 50))

test('LoopbackServer', async (t) => {
  await t.test('redirect URI has the form http://127.0.0.1:<port>/callback', async () => {
    const server = new LoopbackServer()
    try {
      const redirectUri = await server.start()
      assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      assert.equal(server.redirectUri, redirectUri)
      assert.notEqual(new URL(redirectUri).port, '0')
    } finally {
      server.stop()
    }
  })

  await t.test('accepts redirect with valid host, path, state and code', async () => {
    const server = new LoopbackServer()
    try {
      await server.start()
      const redirectPromise = server.waitForRedirect({ state: 'test-state-123' })

      const url = new URL(server.redirectUri)
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

  await t.test('rejects Host: localhost:<port> with 400 and does not resolve', async () => {
    const server = new LoopbackServer()
    try {
      await server.start()
      let settled = false
      server.waitForRedirect({ state: 's' }).then(() => { settled = true }, () => { settled = true })
      const port = Number(new URL(server.redirectUri).port)

      const res = await rawGet(port, '/callback?code=c&state=s', `localhost:${port}`)
      assert.equal(res.status, 400)
      assert.match(res.body, /Invalid host/)
      await tick()
      assert.equal(settled, false)
    } finally {
      server.stop()
    }
  })

  await t.test('rejects other Host headers (DNS rebinding, wrong port, missing port)', async () => {
    const server = new LoopbackServer()
    try {
      await server.start()
      let settled = false
      server.waitForRedirect({ state: 's' }).then(() => { settled = true }, () => { settled = true })
      const port = Number(new URL(server.redirectUri).port)

      for (const host of [`attacker.com:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1']) {
        const res = await rawGet(port, '/callback?code=c&state=s', host)
        assert.equal(res.status, 400, host)
      }
      await tick()
      assert.equal(settled, false)
    } finally {
      server.stop()
    }
  })

  await t.test('rejects wrong path with 400 and keeps waiting', async () => {
    const server = new LoopbackServer()
    try {
      await server.start()
      const redirectPromise = server.waitForRedirect({ state: 's' })
      const port = Number(new URL(server.redirectUri).port)
      const host = `127.0.0.1:${port}`

      for (const path of ['/?code=c&state=s', '/favicon.ico', '/callback/extra?code=c&state=s', '/Callback?code=c&state=s']) {
        const res = await rawGet(port, path, host)
        assert.equal(res.status, 400, path)
        assert.match(res.body, /Invalid path/)
      }

      // A later valid callback still succeeds
      const ok = await rawGet(port, '/callback?code=c&state=s', host)
      assert.equal(ok.status, 200)
      assert.deepEqual(await redirectPromise, { code: 'c', state: 's' })
    } finally {
      server.stop()
    }
  })

  await t.test('rejects wrong state with 400', async () => {
    const server = new LoopbackServer()
    try {
      await server.start()

      let redirectError: Error | null = null
      server.waitForRedirect({ state: 'correct-state' })
        .catch(err => { redirectError = err })

      const url = new URL(server.redirectUri)
      url.searchParams.set('code', 'auth-code-xyz')
      url.searchParams.set('state', 'wrong-state')

      const response = await fetch(url.toString())
      assert.equal(response.status, 400)

      await tick()
      assert.ok(redirectError)
      assert.match(redirectError!.message, /State validation failed/)
    } finally {
      server.stop()
    }
  })

  await t.test('rejects missing state with 400', async () => {
    const server = new LoopbackServer()
    try {
      await server.start()
      server.waitForRedirect({ state: 's' }).catch(() => {})
      const response = await fetch(`${server.redirectUri}?code=c`)
      assert.equal(response.status, 400)
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

      const url = new URL(server.redirectUri)
      url.searchParams.set('error', 'access_denied')
      url.searchParams.set('state', 'test-state')

      const response = await fetch(url.toString())
      assert.equal(response.status, 400)

      await tick()
      assert.ok(redirectError)
      assert.match(redirectError!.message, /access_denied/)
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
      assert.match(login.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      assert.match(login.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/)
    } finally {
      handler.cleanup()
    }
  })

  await t.test('no-browser login runs the loopback listener', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const login = await handler.initiateLogin('no-browser')
    try {
      assert.match(login.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      assert.equal(new URL(login.authorizationUrl).searchParams.get('redirect_uri'), login.redirectUri)
      const done = handler.completeLogin(login)
      const res = await fetch(`${login.redirectUri}?code=nb-code&state=${login.state}`)
      assert.equal(res.status, 200)
      assert.equal((await done).code, 'nb-code')
    } finally {
      handler.cleanup()
    }
  })

  await t.test('manual login uses redirect_uri=http://127.0.0.1/callback and no listener', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const login = await handler.initiateLogin('manual')
    assert.equal(login.redirectUri, MANUAL_REDIRECT_URI)
    assert.equal(MANUAL_REDIRECT_URI, 'http://127.0.0.1/callback')
    const u = new URL(login.authorizationUrl)
    assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1/callback')
    assert.ok(login.authorizationUrl.includes('redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback'))
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    // No listener: completing without a URL source fails immediately
    await assert.rejects(handler.completeLogin(login), /requires/)
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
      userProvidedUrl: `  http://127.0.0.1/callback?code=manual-code&state=${login.state}  \n`,
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
    const login = await handler.initiateLogin('manual')
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

  await t.test('runLogin (loopback): shows URL before waiting, then completes via listener', async () => {
    const handler = new OAuthHandler(config, endpoint)
    const shown: Array<{ url: string; mode: LoginMode }> = []
    const interaction: LoginInteraction = {
      async showAuthorizationUrl(url, mode) {
        shown.push({ url, mode })
        // Simulate the browser following the redirect
        const u = new URL(url)
        const redirect = u.searchParams.get('redirect_uri')!
        setTimeout(() => { void fetch(`${redirect}?code=rl-code&state=${u.searchParams.get('state')}`) }, 10)
      },
      promptForRedirectUrl: async () => { throw new Error('should not prompt') },
    }
    const result = await handler.runLogin('loopback', interaction)
    assert.equal(shown.length, 1)
    assert.equal(shown[0].mode, 'loopback')
    assert.equal(result.code, 'rl-code')
    assert.match(result.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  await t.test('runLogin (manual): prompts for the pasted URL', async () => {
    const handler = new OAuthHandler(config, endpoint)
    let state = ''
    const interaction: LoginInteraction = {
      async showAuthorizationUrl(url) { state = new URL(url).searchParams.get('state')! },
      promptForRedirectUrl: async () => `http://127.0.0.1/callback?code=pasted&state=${state}\n`,
    }
    const result = await handler.runLogin('manual', interaction)
    assert.equal(result.code, 'pasted')
    assert.equal(result.redirectUri, 'http://127.0.0.1/callback')
  })

  await t.test('runLogin releases the listener if showing the URL fails', async () => {
    const handler = new OAuthHandler(config, endpoint)
    let redirect = ''
    const interaction: LoginInteraction = {
      async showAuthorizationUrl(url) {
        redirect = new URL(url).searchParams.get('redirect_uri')!
        throw new Error('io failed')
      },
      promptForRedirectUrl: async () => '',
    }
    await assert.rejects(handler.runLogin('no-browser', interaction), /io failed/)
    await assert.rejects(fetch(`${redirect}?code=a&state=b`))
  })
})
