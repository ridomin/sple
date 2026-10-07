import { test } from 'node:test'
import * as assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, platform } from 'node:os'
import { run } from '../../src/cli/cli.js'
import { loadConfig, loadEnvFile, envFilePermissionWarning } from '../../src/cli/config.js'
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

/** Most CLI tests drive the fake provider, so it is enabled unless a test passes its own env. */
const FAKE_ENABLED = { SPLE_ENABLE_FAKE_PROVIDER: '1' }

async function exec(argv: string[], env: NodeJS.ProcessEnv = FAKE_ENABLED) {
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

test('envFilePermissionWarning warns when .env is readable by others', { skip: platform() === 'win32' }, () => {
  assert.strictEqual(envFilePermissionWarning('/nonexistent/sple/.env'), null)
  const dir = mkdtempSync(join(tmpdir(), 'sple-env-mode-'))
  try {
    const p = join(dir, '.env')
    writeFileSync(p, 'SPLE_X=1\n')
    chmodSync(p, 0o600)
    assert.strictEqual(envFilePermissionWarning(p), null)
    chmodSync(p, 0o640)
    assert.strictEqual(
      envFilePermissionWarning(p),
      `Warning: ${p} is readable by other users. Run: chmod 600 "${p}"`
    )
    chmodSync(p, 0o604)
    assert.match(envFilePermissionWarning(p) ?? '', /readable by other users/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registry instantiates all three providers when the fake provider is enabled', () => {
  const reg = createDefaultRegistry({ enableFake: true })
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
  assert.match(r.out, /query.*Search/i)
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
  assert.match(r.out, /list.*List your playlists/)
  assert.match(r.out, /show.*Show the tracks of a playlist/)
  assert.match(r.out, /create.*Create a new playlist/)
  assert.match(r.out, /remove.*Delete a playlist/)
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

test('migrate is routed: without --from/--to it is a usage error', async () => {
  const r = await exec(['migrate'])
  assert.strictEqual(r.code, EXIT_CODES.USAGE_ERROR)
  assert.match(r.err, /--from and --to are required/)
})

test('--provider flag works end-to-end for commands', async () => {
  const r = await exec(['--provider', 'fake', 'search', 'test'])
  assert.strictEqual(r.code, 0)
  // The fake catalog has no match for "test": the empty-result notice names the provider.
  assert.match(r.err, /Fake Provider/)
})

test('--provider fake playlist list works end-to-end', async () => {
  const r = await exec(['--provider', 'fake', 'playlist', 'list'])
  assert.strictEqual(r.code, 0)
  // The default fake provider has an empty library.
  assert.strictEqual(r.out, '')
  assert.match(r.err, /No playlists\./)
})

// ---- ADR 0007 §1: global flags before or after positionals (M1-14 regression) ----

test('extractGlobalFlags: globals are taken from anywhere before --', async () => {
  const { extractGlobalFlags } = await import('../../src/cli/cli.js')
  const r = extractGlobalFlags(['playlist', 'remove', 'x', '--provider', 'fake', '--yes', '--json', '--', '--quiet'])
  assert.deepStrictEqual(r.values, { provider: 'fake', yes: true, json: true })
  assert.deepStrictEqual(r.rest, ['playlist', 'remove', 'x', '--', '--quiet'])

  const eq = extractGlobalFlags(['search', 'q', '--provider=fake', '--debug'])
  assert.deepStrictEqual(eq.values, { provider: 'fake', debug: true })
  assert.deepStrictEqual(eq.rest, ['search', 'q'])

  // --help before the command is the root help; after it, the command's own.
  assert.deepStrictEqual(extractGlobalFlags(['--help']).values, { help: true })
  assert.deepStrictEqual(extractGlobalFlags(['search', '--help']).rest, ['search', '--help'])

  assert.throws(() => extractGlobalFlags(['search', 'q', '--provider']), UsageError)
  assert.throws(() => extractGlobalFlags(['search', 'q', '--provider', '--json']), UsageError)
})

test('--provider after the command selects that provider', async () => {
  const r = await exec(['search', 'test', '--provider', 'fake'])
  assert.strictEqual(r.code, 0)
  assert.match(r.err, /Fake Provider/)

  const list = await exec(['playlist', 'list', '--provider', 'fake', '--quiet'])
  assert.strictEqual(list.code, 0)
  assert.strictEqual(list.out, '')
})

test('-v after -- is a positional, not --version', async () => {
  const r = await exec(['--provider', 'fake', 'search', '--', '-v'])
  assert.strictEqual(r.code, 0)
  assert.doesNotMatch(r.out, /^sple v/)
})

test('--json failure: last stderr line is a compact ErrorOutput (ADR 0007 §4)', async () => {
  const r = await exec(['playlist', 'show', 'No such playlist', '--provider', 'fake', '--json'])
  assert.strictEqual(r.code, EXIT_CODES.NOT_FOUND)
  assert.strictEqual(r.out, '')
  const lines = r.err.split('\n')
  assert.match(lines[0], /^sple: /)
  const last = JSON.parse(lines[lines.length - 1])
  assert.deepStrictEqual(Object.keys(last.error).sort(), ['exitCode', 'message', 'type'])
  assert.strictEqual(last.error.type, 'NotFoundError')
  assert.strictEqual(last.error.exitCode, EXIT_CODES.NOT_FOUND)
})

test('--debug after the command prints one redacted sple:http line per request (Spotify, mocked)', async () => {
  if (process.platform !== 'linux') return // getConfigDir honours XDG_CONFIG_HOME on Linux only
  const { saveTokens } = await import('../../src/core/config/token-store.js')
  const xdg = mkdtempSync(join(tmpdir(), 'sple-cli-debug-'))
  const prevXdg = process.env.XDG_CONFIG_HOME
  const realFetch = globalThis.fetch
  process.env.XDG_CONFIG_HOME = xdg
  try {
    saveTokens(
      'spotify',
      {
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['playlist-read-private', 'playlist-read-collaborative'],
        userId: 'me',
        grantedAt: '2026-10-01T00:00:00.000Z',
      },
      join(xdg, 'sple')
    )
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 })) as typeof fetch
    const r = await exec(['playlist', 'list', '--debug', '--quiet'], { SPLE_SPOTIFY_CLIENT_ID: 'cid' })
    assert.strictEqual(r.code, 0, r.err)
    // debug may add a timestamp before and +Nms after; only "sple:http <message>" is the contract (ADR-0007 A11).
    assert.match(r.err, /sple:http GET \/v1\/me\/playlists\?limit=50&offset=0 200 \d+ms/)
    assert.ok(!r.err.includes('secret-access-token'))

    // DEBUG selects namespaces without a flag; --verbose leaves out sple:http.
    const viaEnv = await exec(['playlist', 'list', '--quiet'], { SPLE_SPOTIFY_CLIENT_ID: 'cid', DEBUG: 'sple:http' })
    assert.match(viaEnv.err, /sple:http GET \/v1\/me\/playlists/)
    const verbose = await exec(['playlist', 'list', '--verbose', '--quiet'], { SPLE_SPOTIFY_CLIENT_ID: 'cid' })
    assert.ok(!verbose.err.includes('sple:http'), verbose.err)
    const plain = await exec(['playlist', 'list', '--quiet'], { SPLE_SPOTIFY_CLIENT_ID: 'cid' })
    assert.ok(!plain.err.includes('sple:'), plain.err)
  } finally {
    globalThis.fetch = realFetch
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    rmSync(xdg, { recursive: true, force: true })
  }
})

// PRV-6 / ADR-0003 A2: the fake provider is registered only with SPLE_ENABLE_FAKE_PROVIDER=1.
test('the fake provider is not registered by default', async () => {
  assert.deepStrictEqual(createDefaultRegistry().list().sort(), ['spotify', 'youtube-music'])

  const r = await exec(['--provider', 'fake', 'auth', 'status'], {})
  assert.strictEqual(r.code, EXIT_CODES.USAGE_ERROR)
  assert.match(r.err, /Unknown provider 'fake'\. Valid providers: spotify, youtube-music$/m)

  const unknown = await exec(['--provider', 'nope', 'auth', 'status'], {})
  assert.match(unknown.err, /Valid providers: spotify, youtube-music$/m)
})

test('root help lists registered providers only', async () => {
  const plain = await exec(['--help'], {})
  assert.match(plain.out, /--provider <name>\s+Specify the provider \(spotify, youtube-music\)/)
  const withFake = await exec(['--help'])
  assert.match(withFake.out, /--provider <name>\s+Specify the provider \(spotify, youtube-music, fake\)/)
})

test('SPLE_ENABLE_FAKE_PROVIDER=1 registers the fake provider', async () => {
  const r = await exec(['--provider', 'fake', 'playlist', 'list', '--quiet'], { SPLE_ENABLE_FAKE_PROVIDER: '1' })
  assert.strictEqual(r.code, 0)
  assert.deepStrictEqual(createDefaultRegistry({ enableFake: true }).list().sort(), ['fake', 'spotify', 'youtube-music'])
})
