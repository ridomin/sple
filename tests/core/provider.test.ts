import { test } from 'node:test'
import * as assert from 'node:assert'
import {
  AuthRequiredError,
  NotFoundError,
  AccessRestrictedError,
  QuotaExhaustedError,
  RateLimitError,
  UsageError
} from '../../src/core/provider/index.js'
import { getExitCode, formatErrorMessage, EXIT_CODES } from '../../src/cli/exit-codes.js'

test('provider errors', async (t) => {
  await t.test('AuthRequiredError is a ProviderError', () => {
    const err = new AuthRequiredError('No token', 'no-token')
    assert.ok(err instanceof Error)
    assert.strictEqual(err.name, 'AuthRequiredError')
  })

  await t.test('NotFoundError is a ProviderError', () => {
    const err = new NotFoundError('Playlist not found', 'playlist')
    assert.ok(err instanceof Error)
    assert.strictEqual(err.name, 'NotFoundError')
  })

  await t.test('AccessRestrictedError is a ProviderError', () => {
    const err = new AccessRestrictedError('Requires premium', 'premium-required')
    assert.ok(err instanceof Error)
    assert.strictEqual(err.name, 'AccessRestrictedError')
  })

  await t.test('QuotaExhaustedError is a ProviderError', () => {
    const err = new QuotaExhaustedError('Quota exceeded', 'units')
    assert.ok(err instanceof Error)
    assert.strictEqual(err.name, 'QuotaExhaustedError')
  })

  await t.test('RateLimitError is a ProviderError', () => {
    const err = new RateLimitError('Rate limited', 5000)
    assert.ok(err instanceof Error)
    assert.strictEqual(err.name, 'RateLimitError')
  })

  await t.test('UsageError is a ProviderError', () => {
    const err = new UsageError('Invalid flag')
    assert.ok(err instanceof Error)
    assert.strictEqual(err.name, 'UsageError')
  })
})

test('exit code mapping', async (t) => {
  await t.test('AuthRequiredError maps to AUTH_REQUIRED', () => {
    const err = new AuthRequiredError('No token', 'no-token')
    assert.strictEqual(getExitCode(err), EXIT_CODES.AUTH_REQUIRED)
  })

  await t.test('NotFoundError maps to NOT_FOUND', () => {
    const err = new NotFoundError('Not found', 'playlist')
    assert.strictEqual(getExitCode(err), EXIT_CODES.NOT_FOUND)
  })

  await t.test('QuotaExhaustedError maps to QUOTA_EXHAUSTED', () => {
    const err = new QuotaExhaustedError('Quota exceeded', 'units')
    assert.strictEqual(getExitCode(err), EXIT_CODES.QUOTA_EXHAUSTED)
  })

  await t.test('RateLimitError maps to QUOTA_EXHAUSTED', () => {
    const err = new RateLimitError('Rate limited')
    assert.strictEqual(getExitCode(err), EXIT_CODES.QUOTA_EXHAUSTED)
  })

  await t.test('AccessRestrictedError maps to ERROR', () => {
    const err = new AccessRestrictedError('Access denied', 'premium-required')
    assert.strictEqual(getExitCode(err), EXIT_CODES.ERROR)
  })

  await t.test('UsageError maps to USAGE_ERROR', () => {
    const err = new UsageError('Invalid usage')
    assert.strictEqual(getExitCode(err), EXIT_CODES.USAGE_ERROR)
  })

  await t.test('Unknown errors map to ERROR', () => {
    assert.strictEqual(getExitCode(new Error('Unknown')), EXIT_CODES.ERROR)
    assert.strictEqual(getExitCode('string error'), EXIT_CODES.ERROR)
  })
})

test('error message formatting', async (t) => {
  await t.test('formats AuthRequiredError', () => {
    const err = new AuthRequiredError('Auth failed', 'missing-scope', 'playlist-modify')
    const msg = formatErrorMessage(err)
    assert.ok(msg.includes('playlist-modify'))
  })

  await t.test('formats NotFoundError', () => {
    const err = new NotFoundError('Playlist xyz not found', 'playlist')
    const msg = formatErrorMessage(err)
    assert.ok(msg.includes('playlist'))
  })

  await t.test('formats QuotaExhaustedError', () => {
    const err = new QuotaExhaustedError('Quota exceeded', 'units')
    const msg = formatErrorMessage(err)
    assert.ok(msg.includes('units'))
  })

  await t.test('formats RateLimitError with retry', () => {
    const err = new RateLimitError('Rate limited', 5000)
    const msg = formatErrorMessage(err)
    assert.ok(msg.includes('5s'))
  })

  await t.test('formats generic Error', () => {
    const err = new Error('Something went wrong')
    const msg = formatErrorMessage(err)
    assert.strictEqual(msg, 'Something went wrong')
  })
})
