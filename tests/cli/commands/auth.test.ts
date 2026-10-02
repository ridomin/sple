import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../../../src/cli/cli.js'
import { ProviderRegistry } from '../../../src/cli/provider-registry.js'
import { FakeProvider } from '../../../src/providers/fake/index.js'
import { handleAuthCommand } from '../../../src/cli/commands/auth.js'
import { handleLogin } from '../../../src/cli/commands/auth/login.js'
import { handleStatus } from '../../../src/cli/commands/auth/status.js'
import { handleLogout } from '../../../src/cli/commands/auth/logout.js'
import { EXIT_CODES } from '../../../src/cli/exit-codes.js'
import { AuthRequiredError, UsageError } from '../../../src/core/provider/errors.js'
import type { AuthStatus, ProviderAuth } from '../../../src/core/provider/provider.js'

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
  assert.equal(await handleAuthCommand(['login'], p, io), 0)
  assert.equal(await handleAuthCommand(['login', '--no-browser'], p, io), 0)
  assert.equal(await handleAuthCommand(['login', '--manual'], p, io), 0)
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
  const p2 = providerWith({ login: async () => { throw new AuthRequiredError('x', 'playlist-modify') } })
  assert.equal(await handleLogin(p2, io), EXIT_CODES.AUTH_REQUIRED)
})

test('status: not logged in returns AUTH_REQUIRED', async () => {
  const { io, err } = makeIO()
  const p = providerWith({ status: async () => ({ loggedIn: false, scopes: [] }) })
  assert.equal(await handleStatus(p, io), EXIT_CODES.AUTH_REQUIRED)
  assert.deepEqual(err, ['Not logged in to Fake Provider'])
})

test('status: warns when token expires within 5 minutes', async () => {
  const { io, out, err } = makeIO()
  const soon = new Date(Date.now() + 60_000).toISOString()
  const p = providerWith({ status: async () => loggedIn({ expiresAt: soon }) })
  assert.equal(await handleStatus(p, io), 0)
  assert.ok(out.includes(`Token expires: ${soon}`))
  assert.ok(err.some((m) => m.includes('Token expires in less than 5 minutes')))
})

test('status: no warning when expiry is far away; no expiry is fine', async () => {
  const a = makeIO()
  const far = new Date(Date.now() + 3_600_000).toISOString()
  assert.equal(await handleStatus(providerWith({ status: async () => loggedIn({ expiresAt: far }) }), a.io), 0)
  assert.equal(a.err.length, 0)
  const b = makeIO()
  assert.equal(await handleStatus(providerWith({ status: async () => loggedIn() }), b.io), 0)
  assert.ok(!b.out.some((m) => m.startsWith('Token expires')))
})

test('status: provider error returns generic error', async () => {
  const { io, err } = makeIO()
  const p = providerWith({ status: async () => { throw new Error('nope') } })
  assert.equal(await handleStatus(p, io), EXIT_CODES.ERROR)
  assert.match(err[0], /nope/)
})

test('logout: revoked vs local-only, deleted data', async () => {
  const a = makeIO()
  const p1 = providerWith({ logout: async () => ({ revoked: true, deletedData: ['token', 'cache'] }) })
  assert.equal(await handleLogout(p1, a.io), 0)
  assert.deepEqual(a.out, ['Revoked access with Fake Provider', 'Deleted: token, cache'])
  const b = makeIO()
  const p2 = providerWith({ logout: async () => ({ revoked: false, deletedData: [] }) })
  assert.equal(await handleLogout(p2, b.io), 0)
  assert.deepEqual(b.out, ['Logged out from Fake Provider'])
})

test('logout: error returns 1', async () => {
  const { io, err } = makeIO()
  const p = providerWith({ logout: async () => { throw new Error('fail') } })
  assert.equal(await handleLogout(p, io), 1)
  assert.match(err[0], /Logout failed: fail/)
})

test('dispatcher: usage errors thrown', async () => {
  const { io } = makeIO()
  const p = new FakeProvider({ configDir: TEST_CONFIG_DIR })
  await assert.rejects(handleAuthCommand([], p, io), UsageError)
  await assert.rejects(handleAuthCommand(['x'], p, io), UsageError)
  await assert.rejects(handleAuthCommand(['status', '--manual'], p, io), UsageError)
})
