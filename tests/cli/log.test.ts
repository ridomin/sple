import { test } from 'node:test'
import * as assert from 'node:assert'
import createDebug from 'debug'
import { redact, createLogger, setupLogging, formatHttpMessage } from '../../src/cli/log.js'
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

// --- ADR-0007 A11: logging through debug namespaces --------------------------

/** Configure logging as the CLI does, capturing what reaches stderr. */
function capture(opts: { verbose?: boolean; debug?: boolean; DEBUG?: string }): string[] {
  const lines: string[] = []
  setupLogging({ verbose: opts.verbose ?? false, debug: opts.debug ?? false, debugEnv: opts.DEBUG, write: (l) => lines.push(l) })
  return lines
}

/** Emit one line on each namespace. */
function emitAll(message = 'hello') {
  for (const ns of ['sple:import', 'sple:auth', 'sple:spotify:auth', 'sple:http', 'sple:http:retry', 'sple:http:error']) {
    createDebug(ns)('%s', message)
  }
}

const namespacesIn = (lines: string[]) => lines.map((l) => /(sple:[a-z:-]+) /.exec(l)?.[1])

test('neither flag nor DEBUG: no log lines', () => {
  const lines = capture({})
  emitAll()
  assert.deepStrictEqual(lines, [])
})

test('--verbose enables sple:* except sple:http*', () => {
  const lines = capture({ verbose: true })
  emitAll()
  assert.deepStrictEqual(namespacesIn(lines), ['sple:import', 'sple:auth', 'sple:spotify:auth'])
})

test('--debug enables every sple namespace', () => {
  const lines = capture({ debug: true })
  emitAll()
  assert.deepStrictEqual(namespacesIn(lines), ['sple:import', 'sple:auth', 'sple:spotify:auth', 'sple:http', 'sple:http:retry', 'sple:http:error'])
})

test('DEBUG alone selects namespaces; exclusions win when combined with a flag', () => {
  const only = capture({ DEBUG: 'sple:http' })
  emitAll()
  assert.deepStrictEqual(namespacesIn(only), ['sple:http'])

  const without = capture({ debug: true, DEBUG: '-sple:http:retry' })
  emitAll()
  assert.ok(!namespacesIn(without).includes('sple:http:retry'))
  assert.ok(namespacesIn(without).includes('sple:http'))
})

test('the stable part of a line is "sple:<namespace> <message>"', () => {
  const lines = capture({ debug: true })
  createDebug('sple:import')('%s', 'Reading file: x.json')
  assert.strictEqual(lines.length, 1)
  assert.match(lines[0], /sple:import Reading file: x\.json/)
})

test('a % in a message is not treated as a format directive', () => {
  const lines = capture({ debug: true })
  createLogger('import', createMockContext()).info('GET /search?q=100%25%20off %s %o')
  assert.match(lines[0], /GET \/search\?q=100%25%20off %s %o/)
})

test('createLogger: info is a debug log on sple:<namespace>; warn and error always print', () => {
  const lines = capture({ verbose: true })
  const err: string[] = []
  const ctx = { ...createMockContext(), io: { out: () => {}, err: (m: string) => err.push(m) } }
  const log = createLogger('export', ctx)
  log.info('wrote 3 tracks')
  log.warn('careful Bearer abc')
  log.error('broke access_token=xyz')
  assert.strictEqual(lines.length, 1)
  assert.match(lines[0], /sple:export wrote 3 tracks/)
  assert.deepStrictEqual(err, ['sple:export warning: careful Bearer [REDACTED]', 'sple:export broke access_token=[REDACTED]'])
})

test('formatHttpMessage: method, path, status, duration, retries only when > 0', () => {
  assert.strictEqual(
    formatHttpMessage({ method: 'GET', path: '/v1/playlists/x/items?limit=100&offset=0', status: 200, durationMs: 143, retries: 0 }),
    'GET /v1/playlists/x/items?limit=100&offset=0 200 143ms'
  )
  assert.strictEqual(
    formatHttpMessage({ method: 'POST', path: '/api/token', status: 'ERR ECONNRESET', durationMs: 5, retries: 2 }),
    'POST /api/token ERR ECONNRESET 5ms 2 retries'
  )
})

test('no token reaches stderr through any namespace (leak test)', () => {
  const secrets = ['ya29.SECRET-ACCESS', 'AQD-SECRET-REFRESH', 'SECRET-CODE', 'SECRET-VERIFIER', 'SECRET-CLIENT']
  const lines = capture({ DEBUG: 'sple:*' })
  emitAll(
    `Authorization: Bearer ${secrets[0]} refresh_token=${secrets[1]}&code=${secrets[2]}&code_verifier=${secrets[3]} ` +
      `{"client_secret":"${secrets[4]}","access_token":"${secrets[0]}"}`
  )
  assert.strictEqual(lines.length, 6)
  for (const line of lines) for (const secret of secrets) assert.ok(!line.includes(secret), `${secret} leaked: ${line}`)
})
