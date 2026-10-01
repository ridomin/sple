import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generatePKCEPair, deriveChallengeFromVerifier } from '../../../src/core/auth/oauth-handler.js'

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
