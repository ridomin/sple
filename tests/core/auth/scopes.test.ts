import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertScopes, grantedScopes, missingScopes } from '../../../src/core/auth/scopes.js'
import { AuthRequiredError } from '../../../src/core/provider/errors.js'

test('assertScopes throws missing-scope naming the first missing scope', () => {
  assert.doesNotThrow(() => assertScopes(['a', 'b'], ['b']))
  assert.throws(
    () => assertScopes(['a'], ['a', 'b', 'c']),
    (e: unknown) =>
      e instanceof AuthRequiredError &&
      e.reason === 'missing-scope' &&
      e.scope === 'b' &&
      e.message === 'Run "sple auth login" to grant b'
  )
})

test('grantedScopes splits the response scope, or falls back to the requested scopes when absent', () => {
  assert.deepStrictEqual(grantedScopes(' a  b ', ['x']), ['a', 'b'])
  assert.deepStrictEqual(grantedScopes('', ['x']), [])
  assert.deepStrictEqual(grantedScopes(undefined, ['x', 'y']), ['x', 'y'])
})

test('missingScopes lists requested scopes that were not granted, in request order', () => {
  assert.deepStrictEqual(missingScopes(['a', 'b', 'c'], ['c', 'a']), ['b'])
  assert.deepStrictEqual(missingScopes(['a'], ['a', 'z']), [])
})
