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
  const cfg = loadConfig({}, { SPLE_SPOTIFY_CLIENT_ID: 'sid', SPLE_YOUTUBE_MUSIC_CLIENT_ID: 'yid' })
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

test('root help includes all command summaries', async () => {
  const r = await exec(['--help'])
  assert.strictEqual(r.code, 0)
  assert.match(r.out, /sple v/)
  assert.match(r.out, /auth\s+Authentication/)
  assert.match(r.out, /search\s+Search/)
  assert.match(r.out, /playlist\s+Playlist/)
  assert.match(r.out, /export\s+Export/)
  assert.match(r.out, /import\s+Import/)
  assert.match(r.out, /Global Options:/)
  assert.match(r.out, /--provider/)
  assert.match(r.out, /--json/)
  assert.match(r.out, /--quiet/)
  assert.match(r.out, /--verbose/)
  assert.match(r.out, /--debug/)
})

test('search command help text', async () => {
  const r = await exec(['search', '--help'])
  assert.strictEqual(r.code, 0)
  assert.match(r.out, /sple search/)
  assert.match(r.out, /search query/)
})

test('search command requires query argument', async () => {
  const r = await exec(['search'])
  assert.strictEqual(r.code, EXIT_CODES.USAGE_ERROR)
  assert.match(r.err, /No search query provided/)
})

test('playlist command help text', async () => {
  const r = await exec(['playlist', '--help'])
  assert.strictEqual(r.code, 0)
  assert.match(r.out, /Commands:/)
  assert.match(r.out, /list\s+List all playlists/)
  assert.match(r.out, /show\s+Show playlist details/)
  assert.match(r.out, /create\s+Create a new playlist/)
  assert.match(r.out, /remove\s+Delete a playlist/)
})

test('playlist list help text', async () => {
  const r = await exec(['playlist', 'list', '--help'])
  assert.strictEqual(r.code, 0)
  assert.match(r.out, /sple playlist list/)
})

test('playlist show help text', async () => {
  const r = await exec(['playlist', 'show', '--help'])
  assert.strictEqual(r.code, 0)
  assert.match(r.out, /sple playlist show/)
})

test('playlist create help text', async () => {
  const r = await exec(['playlist', 'create', '--help'])
  assert.strictEqual(r.code, 0)
  assert.match(r.out, /sple playlist create/)
})

test('playlist remove help text', async () => {
  const r = await exec(['playlist', 'remove', '--help'])
  assert.strictEqual(r.code, 0)
  assert.match(r.out, /sple playlist remove/)
})

test('export command help text', async () => {
  const r = await exec(['export', '--help'])
  assert.strictEqual(r.code, 0)
  assert.match(r.out, /sple export/)
})

test('unknown playlist subcommand is a usage error', async () => {
  const r = await exec(['playlist', 'invalid-cmd'])
  assert.strictEqual(r.code, EXIT_CODES.USAGE_ERROR)
  assert.match(r.err, /Unknown playlist subcommand/)
  assert.match(r.err, /sple playlist --help/)
})

test('legacy commands exit with helpful message', async () => {
  for (const cmd of ['import', 'migrate']) {
    const r = await exec([cmd])
    assert.strictEqual(r.code, EXIT_CODES.USAGE_ERROR)
    assert.match(r.err, /later release/)
  }
})

test('--provider flag works end-to-end for commands', async () => {
  const r = await exec(['--provider', 'fake', 'search', 'test'])
  assert.strictEqual(r.code, 0)
  assert.match(r.out, /fake/)
})

test('--provider fake playlist list works end-to-end', async () => {
  const r = await exec(['--provider', 'fake', 'playlist', 'list'])
  assert.strictEqual(r.code, 0)
  assert.match(r.out, /fake/)
})
