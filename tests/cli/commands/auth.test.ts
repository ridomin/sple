import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../../../src/cli/cli.js'
import { ProviderRegistry } from '../../../src/cli/provider-registry.js'
import { FakeProvider } from '../../../src/providers/fake/index.js'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'
import { saveTokens, loadTokens } from '../../../src/core/config/token-store.js'
import { loadConfig } from '../../../src/cli/config.js'
import type { AuthTarget } from '../../../src/cli/commands/auth/targets.js'
import type { AuthStatusOutput } from '../../../src/cli/commands/auth/status.js'
import { handleAuthCommand } from '../../../src/cli/commands/auth.js'
import { handleLogin } from '../../../src/cli/commands/auth/login.js'
import { handleStatus } from '../../../src/cli/commands/auth/status.js'
import { handleLogout } from '../../../src/cli/commands/auth/logout.js'
import { EXIT_CODES } from '../../../src/cli/exit-codes.js'
import { AuthRequiredError, UsageError } from '../../../src/core/provider/errors.js'
import type { AuthStatus, Provider, ProviderAuth } from '../../../src/core/provider/provider.js'

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sple-cli-auth-'))

function makeIO() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (m: string) => out.push(m), err: (m: string) => err.push(m) } }
}

function providerWith(auth: Partial<ProviderAuth>) {
  const p = new FakeProvider({ configDir: TEST_CONFIG_DIR })
  p.auth = { ...p.auth, ...auth } as ProviderAuth
  return p
}

const loggedIn = (extra: Partial<AuthStatus> = {}): AuthStatus => ({
  loggedIn: true,
  user: { id: 'u1', displayName: 'User One' },
  scopes: ['a', 'b'],
  ...extra,
})

const target = (p: Provider): AuthTarget => ({ id: p.id, displayName: p.displayName, provider: p })

function authCtx(registry: ProviderRegistry, extra: Record<string, unknown> = {}) {
  return { registry, config: loadConfig({ provider: 'fake' }, {}), providerExplicit: true, ...extra }
}

function registryFor(p: Provider) {
  return new ProviderRegistry().register('fake', () => p)
}

async function exec(argv: string[]) {
  const { io, out, err } = makeIO()
  const registry = new ProviderRegistry().register('fake', () => new FakeProvider({ configDir: TEST_CONFIG_DIR }))
  const code = await run(argv, { io, registry, env: {} })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('cli: auth login/status/logout via run()', async () => {
  const login = await exec(['auth', 'login', '--provider', 'fake'])
  assert.equal(login.code, 0)
  assert.match(login.out, /Logged in/)
  const status = await exec(['auth', 'status', '--provider', 'fake'])
  assert.equal(status.code, 0)
  assert.match(status.out, /User:/)
  const logout = await exec(['auth', 'logout', '--provider', 'fake'])
  assert.equal(logout.code, 0)
  assert.match(logout.out, /Revoked access with Fake Provider/)
})

test('cli: auth usage errors', async () => {
  assert.equal((await exec(['auth', '--provider', 'fake'])).code, EXIT_CODES.USAGE_ERROR)
  assert.equal((await exec(['auth', 'bogus', '--provider', 'fake'])).code, EXIT_CODES.USAGE_ERROR)
  const both = await exec(['auth', 'login', '--no-browser', '--manual', '--provider', 'fake'])
  assert.equal(both.code, EXIT_CODES.USAGE_ERROR)
})

test('login: passes mode (default loopback) and awaits result', async () => {
  const modes: string[] = []
  const p = providerWith({
    login: async ({ mode }) => {
      await Promise.resolve()
      modes.push(mode)
      return loggedIn({ expiresAt: '2030-01-01T00:00:00.000Z' })
    },
  })
  const { io, out } = makeIO()
  const reg = registryFor(p)
  assert.equal(await handleAuthCommand(['login'], authCtx(reg), io), 0)
  assert.equal(await handleAuthCommand(['login'], authCtx(reg, { noBrowser: true }), io), 0)
  assert.equal(await handleAuthCommand(['login'], authCtx(reg, { manual: true }), io), 0)
  assert.deepEqual(modes, ['loopback', 'no-browser', 'manual'])
  assert.ok(out.includes('User: User One'))
  assert.ok(out.includes('Scopes: a, b'))
  assert.ok(out.includes('Token expires: 2030-01-01T00:00:00.000Z'))
})

/** Provider whose login drives the interaction like a real adapter would. */
function interactiveProvider(pastedSink: string[] = []) {
  return providerWith({
    login: async ({ mode, interaction }) => {
      assert.ok(interaction, 'handleLogin must pass an interaction')
      await interaction.showAuthorizationUrl(`https://auth.example/authorize?mode=${mode}`, mode)
      if (mode === 'manual') pastedSink.push(await interaction.promptForRedirectUrl('Paste: '))
      return loggedIn()
    },
  })
}

test('login: URL printed to stderr in all modes; browser opened only in loopback', async () => {
  for (const mode of ['loopback', 'no-browser', 'manual'] as const) {
    const { io, err, out } = makeIO()
    const opened: string[] = []
    const pasted: string[] = []
    const code = await handleLogin(interactiveProvider(pasted), io, {
      mode,
      openBrowser: async (url) => { opened.push(url) },
      readLine: async () => 'http://127.0.0.1/callback?code=c&state=s',
    })
    assert.equal(code, 0, mode)
    const url = `https://auth.example/authorize?mode=${mode}`
    assert.ok(err.includes(url), `${mode}: URL on stderr`)
    assert.ok(!out.some((m) => m.includes(url)), `${mode}: URL not on stdout`)
    assert.deepEqual(opened, mode === 'loopback' ? [url] : [], `${mode}: browser`)
    assert.deepEqual(pasted, mode === 'manual' ? ['http://127.0.0.1/callback?code=c&state=s'] : [])
  }
})

test('login: URL is printed before the browser is opened; browser warnings go to stderr', async () => {
  const { io, err } = makeIO()
  let urlPrintedFirst = false
  const code = await handleLogin(interactiveProvider(), io, {
    mode: 'loopback',
    openBrowser: async (url, { onWarning }) => {
      urlPrintedFirst = err.includes(url)
      onWarning('Warning: could not open a browser (ENOENT)')
    },
  })
  assert.equal(code, 0)
  assert.ok(urlPrintedFirst)
  assert.ok(err.some((m) => m.includes('could not open a browser')))
})

test('login: manual stdin failure is reported as a login failure', async () => {
  const { io, err } = makeIO()
  const code = await handleLogin(interactiveProvider(), io, {
    mode: 'manual',
    readLine: async () => { throw new Error('No redirect URL received (stdin closed)') },
  })
  assert.equal(code, EXIT_CODES.ERROR)
  assert.ok(err.some((m) => /stdin closed/.test(m)))
})

test('login: errors map to exit codes and use formatted messages', async () => {
  const { io, err } = makeIO()
  const p1 = providerWith({ login: async () => { throw new Error('boom') } })
  assert.equal(await handleLogin(p1, io), EXIT_CODES.ERROR)
  assert.match(err[0], /Login failed: boom/)
  const p2 = providerWith({ login: async () => { throw new AuthRequiredError('x', 'missing-scope', 'playlist-modify') } })
  assert.equal(await handleLogin(p2, io), EXIT_CODES.AUTH_REQUIRED)
})

test('status: not logged in still exits 0 (ADR-0007 §3.7)', async () => {
  const { io, out } = makeIO()
  const p = providerWith({ status: async () => ({ loggedIn: false, scopes: [] }) })
  assert.equal(await handleStatus([target(p)], io), EXIT_CODES.SUCCESS)
  assert.deepEqual(out, ['Fake Provider (fake): not logged in'])
})

test('status: shows display name + id, scopes, expiry', async () => {
  const { io, out } = makeIO()
  const far = new Date(Date.now() + 3_600_000).toISOString()
  const p = providerWith({ status: async () => loggedIn({ expiresAt: far }) })
  assert.equal(await handleStatus([target(p)], io), 0)
  assert.deepEqual(out, [
    'Fake Provider (fake): logged in',
    '  User: User One (u1)',
    '  Scopes: a b',
    `  Token expires: ${far}`,
  ])
})

test('status: warns when token expires within 5 minutes', async () => {
  const { io, out, err } = makeIO()
  const soon = new Date(Date.now() + 60_000).toISOString()
  const p = providerWith({ status: async () => loggedIn({ expiresAt: soon }) })
  assert.equal(await handleStatus([target(p)], io), 0)
  assert.ok(out.includes(`  Token expires: ${soon}`))
  assert.ok(err.some((m) => m.includes('expires in less than 5 minutes')))
})

test('status: no warning when expiry is far away; no expiry is fine', async () => {
  const a = makeIO()
  const far = new Date(Date.now() + 3_600_000).toISOString()
  assert.equal(await handleStatus([target(providerWith({ status: async () => loggedIn({ expiresAt: far }) }))], a.io), 0)
  assert.equal(a.err.length, 0)
  const b = makeIO()
  assert.equal(await handleStatus([target(providerWith({ status: async () => loggedIn() }))], b.io), 0)
  assert.ok(!b.out.some((m) => m.includes('Token expires')))
})

test('status --json: ADR-0007 shape, optional fields omitted', async () => {
  const { io, out } = makeIO()
  const p1 = providerWith({ status: async () => loggedIn({ expiresAt: '2030-01-01T00:00:00.000Z' }) })
  const p2 = providerWith({ status: async () => ({ loggedIn: false, scopes: [] }) })
  const t2: AuthTarget = { ...target(p2), id: 'spotify' }
  assert.equal(await handleStatus([target(p1), t2], io, { json: true }), 0)
  assert.equal(out.length, 1)
  const parsed = JSON.parse(out[0]) satisfies AuthStatusOutput
  assert.deepEqual(parsed, {
    providers: [
      {
        id: 'fake',
        loggedIn: true,
        user: { id: 'u1', displayName: 'User One' },
        scopes: ['a', 'b'],
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
      { id: 'spotify', loggedIn: false, scopes: [] },
    ],
  })
  assert.match(out[0], /^\{\n {2}"providers"/)
})

test('status: provider error returns its exit code; --json stdout stays empty', async () => {
  const { io, out, err } = makeIO()
  const p = providerWith({ status: async () => { throw new Error('nope') } })
  assert.equal(await handleStatus([target(p)], io, { json: true }), EXIT_CODES.ERROR)
  assert.equal(out.length, 0)
  assert.match(err[0], /nope/)
})

test('logout: revoked vs local-only, deleted data, notice', async () => {
  const a = makeIO()
  const p1 = providerWith({ logout: async () => ({ revoked: true, deletedData: ['token', 'cache'] }) })
  assert.equal(await handleLogout([target(p1)], a.io), 0)
  assert.deepEqual(a.out, ['Revoked access with Fake Provider', 'Deleted: token, cache'])
  const b = makeIO()
  const p2 = providerWith({ logout: async () => ({ revoked: false, deletedData: [], notice: 'Do X' }) })
  assert.equal(await handleLogout([target(p2)], b.io), 0)
  assert.deepEqual(b.out, ['Logged out from Fake Provider', 'Do X'])
})

test('logout: error returns 1 but other providers are still logged out', async () => {
  const { io, err, out } = makeIO()
  const bad = providerWith({ logout: async () => { throw new Error('fail') } })
  const good = providerWith({ logout: async () => ({ revoked: true, deletedData: [] }) })
  assert.equal(await handleLogout([target(bad), target(good)], io), 1)
  assert.match(err[0], /Logout failed for Fake Provider: fail/)
  assert.deepEqual(out, ['Revoked access with Fake Provider'])
})

test('dispatcher: usage errors thrown', async () => {
  const { io } = makeIO()
  const reg = registryFor(new FakeProvider({ configDir: TEST_CONFIG_DIR }))
  await assert.rejects(handleAuthCommand([], authCtx(reg), io), UsageError)
  await assert.rejects(handleAuthCommand(['x'], authCtx(reg), io), UsageError)
  await assert.rejects(handleAuthCommand(['status', 'extra'], authCtx(reg), io), UsageError)
  await assert.rejects(handleAuthCommand(['status'], authCtx(reg, { manual: true }), io), UsageError)
  await assert.rejects(handleAuthCommand(['status'], authCtx(reg, { all: true }), io), UsageError)
  await assert.rejects(handleAuthCommand(['login'], authCtx(reg, { json: true }), io), UsageError)
  await assert.rejects(handleAuthCommand(['logout'], authCtx(reg, { json: true }), io), UsageError)
  await assert.rejects(handleAuthCommand(['logout'], authCtx(reg, { all: true }), io), UsageError)
})

// ---- Multi-provider (FR-AUTH-6), via run() with real token files ----

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'sple-cli-multi-'))
}

function storeToken(dir: string, id: 'spotify' | 'fake', scopes: string[]) {
  saveTokens(
    id,
    {
      accessToken: `${id}-access`,
      refreshToken: `${id}-refresh`,
      expiresAt: '2030-01-01T00:00:00.000Z',
      scopes,
      userId: `${id}-user`,
      displayName: `${id} name`,
      grantedAt: '2026-10-02T00:00:00.000Z',
    },
    dir
  )
}

async function execMulti(dir: string, argv: string[]) {
  const { io, out, err } = makeIO()
  const registry = new ProviderRegistry()
    .register('spotify', () => createSpotifyProvider('test-client-id', dir))
    .register('fake', () => new FakeProvider({ configDir: dir }))
  const code = await run(argv, { io, registry, env: {} })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('status without --provider lists every registered provider', async () => {
  const dir = freshDir()
  storeToken(dir, 'spotify', ['playlist-read-private'])
  assert.equal((await execMulti(dir, ['auth', 'login', '--provider', 'fake'])).code, 0)

  const human = await execMulti(dir, ['auth', 'status'])
  assert.equal(human.code, 0)
  assert.match(human.out, /Spotify \(spotify\): logged in/)
  assert.match(human.out, /User: spotify name \(spotify-user\)/)
  assert.match(human.out, /Fake Provider \(fake\): logged in/)

  const json = await execMulti(dir, ['auth', 'status', '--json'])
  assert.equal(json.code, 0)
  const parsed = JSON.parse(json.out) as AuthStatusOutput
  assert.deepEqual(parsed.providers.map((p) => [p.id, p.loggedIn]), [['spotify', true], ['fake', true]])
  assert.deepEqual(parsed.providers[0].scopes, ['playlist-read-private'])

  const one = JSON.parse((await execMulti(dir, ['auth', 'status', '--provider', 'fake', '--json'])).out)
  assert.deepEqual(one.providers.map((p: { id: string }) => p.id), ['fake'])
})

test('logout --provider fake leaves Spotify intact', async () => {
  const dir = freshDir()
  storeToken(dir, 'spotify', ['playlist-read-private'])
  storeToken(dir, 'fake', ['all'])
  const r = await execMulti(dir, ['auth', 'logout', '--provider', 'fake'])
  assert.equal(r.code, 0)
  assert.equal(loadTokens('fake', dir), null)
  assert.equal(loadTokens('spotify', dir)?.accessToken, 'spotify-access')
})

test('logout --provider spotify deletes tokens and explains there is no revoke endpoint', async () => {
  const dir = freshDir()
  storeToken(dir, 'spotify', ['playlist-read-private'])
  storeToken(dir, 'fake', ['all'])
  const r = await execMulti(dir, ['auth', 'logout', '--provider', 'spotify'])
  assert.equal(r.code, 0)
  assert.match(r.out, /Logged out from Spotify/)
  assert.match(r.out, /no revoke endpoint/)
  assert.match(r.out, /https:\/\/www\.spotify\.com\/account\/apps\//)
  assert.equal(loadTokens('spotify', dir), null)
  assert.ok(loadTokens('fake', dir))
})

test('logout --all logs out every provider', async () => {
  const dir = freshDir()
  storeToken(dir, 'spotify', ['playlist-read-private'])
  storeToken(dir, 'fake', ['all'])
  const r = await execMulti(dir, ['auth', 'logout', '--all'])
  assert.equal(r.code, 0)
  assert.equal(loadTokens('spotify', dir), null)
  assert.equal(loadTokens('fake', dir), null)
  const file = JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf-8'))
  assert.deepEqual(file.providers, {})
  const status = JSON.parse((await execMulti(dir, ['auth', 'status', '--json'])).out) as AuthStatusOutput
  assert.ok(status.providers.every((p) => !p.loggedIn))
})

test('logout --all with --provider is a usage error', async () => {
  const r = await execMulti(freshDir(), ['auth', 'logout', '--all', '--provider', 'fake'])
  assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
})

test('status/logout work from the token store when a provider has no client ID', async () => {
  if (process.platform !== 'linux') return // getConfigDir honours XDG_CONFIG_HOME on Linux only
  const xdg = freshDir()
  const prev = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = xdg
  try {
    const dir = join(xdg, 'sple')
    storeToken(dir, 'spotify', ['playlist-read-private'])
    const exec2 = async (argv: string[]) => {
      const { io, out, err } = makeIO()
      const registry = new ProviderRegistry()
        .register('spotify', () => { throw new UsageError('Missing Spotify client ID') })
        .register('fake', () => new FakeProvider({ configDir: dir }))
      const code = await run(argv, { io, registry, env: {} })
      return { code, out: out.join('\n'), err: err.join('\n') }
    }
    const status = await exec2(['auth', 'status', '--json'])
    assert.equal(status.code, 0)
    const parsed = JSON.parse(status.out) as AuthStatusOutput
    assert.equal(parsed.providers.find((p) => p.id === 'spotify')?.loggedIn, true)

    const logout = await exec2(['auth', 'logout', '--all'])
    assert.equal(logout.code, 0)
    assert.match(logout.err, /not revoked/)
    assert.equal(loadTokens('spotify', dir), null)
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
  }
})

test('--provider works before and after the auth subcommand (ADR 0007 §1)', async () => {
  for (const argv of [
    ['--provider', 'fake', 'auth', 'logout'],
    ['auth', '--provider', 'fake', 'logout'],
    ['auth', 'logout', '--provider=fake'],
  ]) {
    const dir = freshDir()
    storeToken(dir, 'spotify', ['playlist-read-private'])
    storeToken(dir, 'fake', ['all'])
    const r = await execMulti(dir, argv)
    assert.equal(r.code, 0, argv.join(' '))
    assert.equal(loadTokens('fake', dir), null, argv.join(' '))
    assert.equal(loadTokens('spotify', dir)?.accessToken, 'spotify-access', argv.join(' '))
  }
})

test('auth: unknown flags are usage errors; --help prints usage', async () => {
  const r = await execMulti(freshDir(), ['auth', 'logout', '--bogus'])
  assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
  const help = await execMulti(freshDir(), ['auth', 'login', '--help'])
  assert.equal(help.code, 0)
  assert.match(help.out, /Usage: sple auth login/)
})

test('--quiet suppresses the stdout lines of auth login and logout (ADR-0007 §3.7, A10)', async () => {
  const login = await exec(['--quiet', 'auth', 'login', '--provider', 'fake'])
  assert.equal(login.code, 0)
  assert.equal(login.out, '')
  const logout = await exec(['auth', 'logout', '--provider', 'fake', '--quiet'])
  assert.equal(logout.code, 0)
  assert.equal(logout.out, '')
})

test('--quiet still reports logout failures on stderr', async () => {
  const p = providerWith({ logout: async () => { throw new Error('revoke failed') } })
  const { io, out, err } = makeIO()
  const code = await run(['--quiet', 'auth', 'logout', '--provider', 'fake'], { io, registry: registryFor(p), env: {} })
  assert.notEqual(code, 0)
  assert.deepEqual(out, [])
  assert.ok(err.some((m) => /revoke failed/.test(m)), err.join('\n'))
})
