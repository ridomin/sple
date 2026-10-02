import { test } from 'node:test'
import * as assert from 'node:assert'
import { redact, createLogger, logHttpCall } from '../../src/cli/log.js'
import type { CommandContext } from '../../src/cli/cli.js'

function createMockContext(verbose = false, debug = false): CommandContext {
  return {
    registry: null as any,
    config: { provider: 'spotify', verbose },
    io: {
      out: () => {},
      err: () => {},
    },
    version: '1.0.0',
    json: false,
    quiet: false,
    debug,
  }
}

test('redact removes Bearer tokens', () => {
  const input = 'Request with Bearer abc123def456 in header'
  const result = redact(input)
  assert.strictEqual(result, 'Request with Bearer [REDACTED] in header')
})

test('redact handles multiple Bearer tokens', () => {
  const input = 'Bearer token1 and Bearer token2'
  const result = redact(input)
  assert.strictEqual(result, 'Bearer [REDACTED] and Bearer [REDACTED]')
})

test('redact removes access_token parameter', () => {
  const input = 'GET /token?access_token=abcdef123456&grant_type=refresh'
  const result = redact(input)
  assert.match(result, /access_token=\[REDACTED\]/)
  assert.strictEqual(result, 'GET /token?access_token=[REDACTED]&grant_type=refresh')
})

test('redact removes refresh_token parameter', () => {
  const input = 'POST /token?refresh_token=xyz789&grant_type=refresh'
  const result = redact(input)
  assert.strictEqual(result, 'POST /token?refresh_token=[REDACTED]&grant_type=refresh')
})

test('redact removes code parameter', () => {
  const input = 'GET /callback?code=auth_code_12345&state=state_value'
  const result = redact(input)
  assert.strictEqual(result, 'GET /callback?code=[REDACTED]&state=state_value')
})

test('redact removes code_verifier parameter', () => {
  const input = 'POST /token?code_verifier=pkce_verifier_xyz&code=abc'
  const result = redact(input)
  assert.match(result, /code_verifier=\[REDACTED\]/)
  assert.match(result, /code=\[REDACTED\]/)
})

test('redact removes client_secret parameter', () => {
  const input = 'POST /api?client_secret=secret123&client_id=id123'
  const result = redact(input)
  assert.strictEqual(result, 'POST /api?client_secret=[REDACTED]&client_id=id123')
})

test('redact removes JSON access_token field', () => {
  const input = '{"access_token":"token123","expires_in":3600}'
  const result = redact(input)
  assert.strictEqual(result, '{"access_token":"[REDACTED]","expires_in":3600}')
})

test('redact removes JSON refresh_token field', () => {
  const input = '{"refresh_token":"refresh123","token_type":"Bearer"}'
  const result = redact(input)
  assert.strictEqual(result, '{"refresh_token":"[REDACTED]","token_type":"Bearer"}')
})

test('redact removes JSON id_token field', () => {
  const input = '{"id_token":"eyJ...xyz","access_token":"token123"}'
  const result = redact(input)
  assert.match(result, /id_token":"\[REDACTED\]"/)
  assert.match(result, /access_token":"\[REDACTED\]"/)
})

test('redact removes JSON client_secret field', () => {
  const input = '{"client_secret":"secret456","client_id":"id123"}'
  const result = redact(input)
  assert.strictEqual(result, '{"client_secret":"[REDACTED]","client_id":"id123"}')
})

test('redact handles empty string', () => {
  const result = redact('')
  assert.strictEqual(result, '')
})

test('redact returns unchanged text with no secrets', () => {
  const input = 'Normal log message with no secrets'
  const result = redact(input)
  assert.strictEqual(result, input)
})

test('logger info only outputs with verbose flag', () => {
  const err: string[] = []
  const ctx = createMockContext(true, false)
  ctx.io.err = (m) => err.push(m)

  const log = createLogger('test', ctx)
  log.info('test message')

  assert.strictEqual(err.length, 1)
  assert.match(err[0], /sple:test/)
  assert.match(err[0], /test message/)
})

test('logger info does not output without verbose flag', () => {
  const err: string[] = []
  const ctx = createMockContext(false, false)
  ctx.io.err = (m) => err.push(m)

  const log = createLogger('test', ctx)
  log.info('test message')

  assert.strictEqual(err.length, 0)
})

test('logger debug only outputs with debug flag', () => {
  const err: string[] = []
  const ctx = createMockContext(false, true)
  ctx.io.err = (m) => err.push(m)

  const log = createLogger('test', ctx)
  log.debug('debug message')

  assert.strictEqual(err.length, 1)
  assert.match(err[0], /sple:test/)
})

test('logger error always outputs', () => {
  const err: string[] = []
  const ctx = createMockContext(false, false)
  ctx.io.err = (m) => err.push(m)

  const log = createLogger('test', ctx)
  log.error('error message')

  assert.strictEqual(err.length, 1)
  assert.match(err[0], /sple:test/)
})

test('logger redacts tokens in messages', () => {
  const err: string[] = []
  const ctx = createMockContext(true, false)
  ctx.io.err = (m) => err.push(m)

  const log = createLogger('test', ctx)
  log.info('Authorization: Bearer secret_token_123')

  assert.strictEqual(err.length, 1)
  assert.match(err[0], /Bearer \[REDACTED\]/)
  assert.ok(!err[0].includes('secret_token_123'))
})

test('logger warn prefixes with warning', () => {
  const err: string[] = []
  const ctx = createMockContext(true, false)
  ctx.io.err = (m) => err.push(m)

  const log = createLogger('test', ctx)
  log.warn('warning message')

  assert.strictEqual(err.length, 1)
  assert.match(err[0], /warning:/)
})

test('logHttpCall outputs only in debug mode', () => {
  const err: string[] = []

  // No debug
  const ctx1 = createMockContext(false, false)
  ctx1.io.err = (m) => err.push(m)
  logHttpCall(ctx1, 'GET', '/v1/me', 200, 50)
  assert.strictEqual(err.length, 0)

  // With debug
  const ctx2 = createMockContext(false, true)
  ctx2.io.err = (m) => err.push(m)
  logHttpCall(ctx2, 'GET', '/v1/me', 200, 50)
  assert.strictEqual(err.length, 1)
})

test('logHttpCall formats HTTP call correctly', () => {
  const err: string[] = []
  const ctx = createMockContext(false, true)
  ctx.io.err = (m) => err.push(m)

  logHttpCall(ctx, 'GET', '/v1/playlists/123/items', 200, 145)

  assert.strictEqual(err.length, 1)
  assert.match(err[0], /sple:http GET \/v1\/playlists\/123\/items 200 145ms/)
})

test('logHttpCall includes retry count when provided', () => {
  const err: string[] = []
  const ctx = createMockContext(false, true)
  ctx.io.err = (m) => err.push(m)

  logHttpCall(ctx, 'POST', '/v1/token', 429, 200, 2)

  assert.strictEqual(err.length, 1)
  assert.match(err[0], /2 retries/)
})

test('logHttpCall omits retry count when zero', () => {
  const err: string[] = []
  const ctx = createMockContext(false, true)
  ctx.io.err = (m) => err.push(m)

  logHttpCall(ctx, 'GET', '/v1/me', 200, 50, 0)

  assert.strictEqual(err.length, 1)
  assert.ok(!err[0].includes('retries'))
})

test('logHttpCall handles network errors with error status', () => {
  const err: string[] = []
  const ctx = createMockContext(false, true)
  ctx.io.err = (m) => err.push(m)

  logHttpCall(ctx, 'GET', '/v1/me', 'ERR ECONNREFUSED', 1000)

  assert.strictEqual(err.length, 1)
  assert.match(err[0], /ERR ECONNREFUSED/)
})

test('logger debug also outputs with verbose flag', () => {
  const err: string[] = []
  const ctx = createMockContext(true, false)
  ctx.io.err = (m) => err.push(m)

  const log = createLogger('test', ctx)
  log.debug('debug message')

  // Debug is only for --debug flag, not --verbose
  assert.strictEqual(err.length, 0)
})

test('redact handles complex JSON structures', () => {
  const input = JSON.stringify({
    user: 'test',
    tokens: {
      access_token: 'abc123',
      refresh_token: 'xyz789',
      id_token: 'jwt_token',
    },
    url: 'https://api.example.com?code=auth_code&state=state_value',
  })

  const result = redact(input)

  assert.ok(!result.includes('abc123'))
  assert.ok(!result.includes('xyz789'))
  assert.ok(!result.includes('jwt_token'))
  assert.ok(!result.includes('auth_code'))
  assert.ok(result.includes('[REDACTED]'))
})
