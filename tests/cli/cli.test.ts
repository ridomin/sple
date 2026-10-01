import { test } from 'node:test'
import * as assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../../src/cli/cli.js'
import { loadConfig, loadEnvFile } from '../../src/cli/config.js'
import { createDefaultRegistry } from '../../src/cli/provider-registry.js'
import { EXIT_CODES, getExitCode } from '../../src/cli/exit-codes.js'
import { readPackageVersion } from '../../src/cli/version.js'
import {
  AuthRequiredError,
  NotFoundError,
  RateLimitError,
  QuotaExhaustedError,
  UsageError,
  ProviderError,
} from '../../src/core/provider/errors.js'

async function exec(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(argv, {
    io: { out: (m) => out.push(m), err: (m) => err.push(m) },
    env,
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('--version prints package.json version', async () => {
  const r = await exec(['--version'])
  assert.strictEqual(r.code, 0)
  assert.strictEqual(r.out, `sple v${readPackageVersion()}`)
  assert.notStrictEqual(readPackageVersion(), 'unknown')
})

test('--help and no args show help', async () => {
  for (const argv of [['--help'], ['-h'], []]) {
    const r = await exec(argv)
    assert.strictEqual(r.code, 0)
    assert.match(r.out, /Usage: sple/)
    assert.match(r.out, /--provider/)
  }
})

test('unknown command and flag are usage errors', async () => {
  assert.strictEqual((await exec(['bogus'])).code, EXIT_CODES.USAGE_ERROR)
  assert.strictEqual((await exec(['--nope'])).code, EXIT_CODES.USAGE_ERROR)
})

test('invalid provider is a usage error', async () => {
  const r = await exec(['--provider', 'tidal', 'auth'])
  assert.strictEqual(r.code, EXIT_CODES.USAGE_ERROR)
  assert.match(r.err, /Unknown provider/)
})

test('verbose logs to stderr', async () => {
  const r = await exec(['--verbose', '--provider', 'fake', 'auth'])
  assert.match(r.err, /provider=fake/)
})

test('config defaults to spotify and honors env and flag precedence', () => {
  assert.strictEqual(loadConfig({}, {}).provider, 'spotify')
  assert.strictEqual(loadConfig({}, { SPLE_DEFAULT_PROVIDER: 'youtube-music' }).provider, 'youtube-music')
  assert.strictEqual(
    loadConfig({ provider: 'fake' }, { SPLE_DEFAULT_PROVIDER: 'youtube-music' }).provider,
    'fake'
  )
  const c = loadConfig({ verbose: true }, { SPLE_SPOTIFY_CLIENT_ID: ' abc ', SPLE_GOOGLE_CLIENT_SECRET: '' })
  assert.strictEqual(c.verbose, true)
  assert.strictEqual(c.spotifyClientId, 'abc')
  assert.strictEqual(c.googleClientSecret, undefined)
  assert.throws(() => loadConfig({ provider: 'x' }, {}), UsageError)
})

test('loadEnvFile handles missing and present files', () => {
  assert.strictEqual(loadEnvFile('/nonexistent/sple/.env'), false)
  const dir = mkdtempSync(join(tmpdir(), 'sple-env-'))
  try {
    const p = join(dir, '.env')
    writeFileSync(p, '# c\nSPLE_TEST_ENV_VAR=hello\n')
    assert.strictEqual(loadEnvFile(p), true)
    assert.strictEqual(process.env.SPLE_TEST_ENV_VAR, 'hello')
  } finally {
    delete process.env.SPLE_TEST_ENV_VAR
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registry instantiates all three providers', () => {
  const reg = createDefaultRegistry()
  const cfg = loadConfig({}, {})
  assert.deepStrictEqual(reg.list().sort(), ['fake', 'spotify', 'youtube-music'])
  for (const id of reg.list()) {
    assert.strictEqual(reg.create(id, cfg).id, id)
  }
  assert.throws(() => reg.create('nope', cfg), UsageError)
})

test('exit code mapping', () => {
  assert.strictEqual(getExitCode(new AuthRequiredError('x', 'no-token')), 3)
  assert.strictEqual(getExitCode(new NotFoundError('x', 'track')), 4)
  assert.strictEqual(getExitCode(new RateLimitError('x')), 5)
  assert.strictEqual(getExitCode(new QuotaExhaustedError('x', 'b')), 5)
  assert.strictEqual(getExitCode(new UsageError('x')), 2)
  assert.strictEqual(getExitCode(new ProviderError('x')), 1)
  assert.strictEqual(getExitCode('str'), 1)
})
