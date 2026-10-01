import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LoopbackServer } from '../../../src/core/auth/oauth-handler.js'

test('LoopbackServer', async (t) => {
  await t.test('binds to localhost on a random port', async () => {
    const server = new LoopbackServer()
    const baseUrl = await server.start()

    assert.match(baseUrl, /^http:\/\/localhost:\d+\/$/)

    server.stop()
  })

  await t.test('accepts redirect with valid state and code', async () => {
    const server = new LoopbackServer()
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

    server.stop()
  })

  await t.test('rejects redirect with mismatched state', async () => {
    const server = new LoopbackServer()
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
    assert.match(redirectError!.message, /State mismatch/)

    server.stop()
  })

  await t.test('rejects redirect with error parameter', async () => {
    const server = new LoopbackServer()
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

    server.stop()
  })
})
