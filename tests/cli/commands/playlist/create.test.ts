import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run as createRun } from '../../../../src/cli/commands/playlist/create.js'
import { run as cliRun } from '../../../../src/cli/cli.js'
import { EXIT_CODES } from '../../../../src/cli/exit-codes.js'
import type { PlaylistCreateOutput } from '../../../../src/cli/output/types.js'
import { FakeProvider } from '../../../../src/providers/fake/index.js'
import { createSpotifyProvider } from '../../../../src/providers/spotify/index.js'
import { saveTokens } from '../../../../src/core/config/token-store.js'
import { runCommand, spyWrites, mockFetch, jsonResponse, type FetchCall } from './helpers.js'

function setup(caps: ConstructorParameters<typeof FakeProvider>[0] = {}) {
  const provider = new FakeProvider(caps)
  const writes = spyWrites(provider)
  return { provider, writes }
}

const create = (provider: FakeProvider, args: string[], tty = false, flags = {}) =>
  runCommand(provider, (ctx) => createRun(ctx, args, { stdoutIsTTY: tty }), flags)

// --- visibility ---------------------------------------------------------------

test('create defaults to a private, non-collaborative playlist', async () => {
  const { provider, writes } = setup()
  const r = await create(provider, ['Road Trip'], false, { json: true })
  assert.equal(r.code, 0)
  assert.equal(writes.create, 1)
  const out = JSON.parse(r.out) as PlaylistCreateOutput
  assert.equal(out.dryRun, false)
  assert.equal(out.public, false)
  assert.equal(out.collaborative, false)
  const stored = await provider.getPlaylist((out as { id: string }).id)
  assert.equal(stored.public, false)
})

test('create --public makes a public playlist', async () => {
  const { provider } = setup()
  const r = await create(provider, ['Road Trip', '--public', '--json'])
  assert.equal(r.code, 0)
  const out = JSON.parse(r.out) as PlaylistCreateOutput
  assert.equal(out.public, true)
  assert.equal(out.collaborative, false)
})

test('create --private makes a private playlist', async () => {
  const { provider } = setup()
  const r = await create(provider, ['--private', 'Road Trip', '--json'])
  assert.equal(r.code, 0)
  assert.equal((JSON.parse(r.out) as PlaylistCreateOutput).public, false)
})

test('create --collaborative implies private', async () => {
  const { provider } = setup()
  const r = await create(provider, ['Party', '--collaborative', '--json'])
  assert.equal(r.code, 0)
  const out = JSON.parse(r.out) as PlaylistCreateOutput
  assert.equal(out.public, false)
  assert.equal(out.collaborative, true)
})

test('create --collaborative --private is accepted', async () => {
  const { provider } = setup()
  const r = await create(provider, ['Party', '--collaborative', '--private', '--json'])
  assert.equal(r.code, 0)
  assert.equal((JSON.parse(r.out) as PlaylistCreateOutput).collaborative, true)
})

test('create --collaborative --public exits 2 with no write', async () => {
  const { provider, writes } = setup()
  const r = await create(provider, ['Party', '--collaborative', '--public'])
  assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
  assert.match(r.err, /collaborative/)
  assert.equal(writes.create, 0)
})

test('create --public --private exits 2 with no write', async () => {
  const { provider, writes } = setup()
  const r = await create(provider, ['X', '--public', '--private'])
  assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
  assert.equal(writes.create, 0)
})

test('create --collaborative exits 2 when the provider lacks supportsCollaborative', async () => {
  const { provider, writes } = setup({ capabilities: { supportsCollaborative: false } })
  const r = await create(provider, ['Party', '--collaborative'])
  assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
  assert.match(r.err, /Fake Provider does not support collaborative/)
  assert.equal(writes.create, 0)
})

// --- argument validation -----------------------------------------------------

test('create without a name exits 2', async () => {
  const { provider } = setup()
  for (const args of [[], [''], ['   ']]) {
    const r = await create(provider, args)
    assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
    assert.match(r.err, /No playlist name provided/)
  }
})

test('create with two positionals exits 2', async () => {
  const { provider, writes } = setup()
  const r = await create(provider, ['Road', 'Trip'])
  assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
  assert.equal(writes.create, 0)
})

test('create with an unknown flag or missing --description value exits 2', async () => {
  const { provider } = setup()
  assert.equal((await create(provider, ['X', '--bogus'])).code, EXIT_CODES.USAGE_ERROR)
  assert.equal((await create(provider, ['X', '--description'])).code, EXIT_CODES.USAGE_ERROR)
})

test('create --json --quiet exits 2', async () => {
  const { provider, writes } = setup()
  const r = await create(provider, ['X', '--json', '--quiet'])
  assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
  assert.equal(writes.create, 0)
})

// --- dry run -----------------------------------------------------------------

test('create --dry-run makes no write call in every output mode', async () => {
  const modes: Array<{ args: string[]; tty?: boolean }> = [
    { args: [] },
    { args: [], tty: true },
    { args: ['--json'] },
    { args: ['--quiet'] },
  ]
  for (const m of modes) {
    const { provider, writes } = setup()
    const r = await create(provider, ['Road Trip', '--dry-run', ...m.args], m.tty)
    assert.equal(r.code, 0)
    assert.equal(writes.create, 0)
    const list = await provider.listPlaylists({ limit: 50 })
    assert.equal(list.items.length, 0)
  }
})

test('create --dry-run --json prints the planned playlist', async () => {
  const { provider } = setup()
  const r = await create(provider, ['Party', '--collaborative', '--description', 'Tunes', '--dry-run', '--json'])
  assert.equal(r.code, 0)
  const out = JSON.parse(r.out)
  const expected = {
    dryRun: true,
    name: 'Party',
    description: 'Tunes',
    public: false,
    collaborative: true,
  } satisfies PlaylistCreateOutput
  assert.deepEqual(out, expected)
})

test('create --dry-run on a TTY prints a [dry-run] sentence', async () => {
  const { provider } = setup()
  const r = await create(provider, ['Road Trip', '--public', '--dry-run'], true)
  assert.equal(r.out, '[dry-run] Would create public playlist "Road Trip" in Fake Provider')
})

test('create --dry-run TSV has an empty id and --quiet prints nothing', async () => {
  const { provider } = setup()
  assert.equal((await create(provider, ['Road Trip', '--dry-run'])).out, '\tRoad Trip\t')
  assert.equal((await create(provider, ['Road Trip', '--dry-run', '--quiet'])).out, '')
})

// --- output modes ------------------------------------------------------------

test('create --json output satisfies PlaylistCreateOutput', async () => {
  const { provider } = setup({ userId: 'me' })
  const r = await create(provider, ['Road Trip', '--description', 'Drive'], false, { json: true })
  const out = JSON.parse(r.out)
  const expected = {
    dryRun: false,
    id: '1',
    ref: '1',
    name: 'Road Trip',
    description: 'Drive',
    owner: { id: 'me', displayName: 'me' },
    public: false,
    collaborative: false,
  } satisfies PlaylistCreateOutput
  assert.deepEqual(out, expected)
})

test('create on a TTY prints a confirmation sentence with the ID', async () => {
  const { provider } = setup()
  const r = await create(provider, ['Road Trip'], true)
  assert.equal(r.out, 'Created private playlist "Road Trip" (1)')
})

test('create TSV prints id, name, url and --quiet prints the ID', async () => {
  const { provider } = setup()
  assert.equal((await create(provider, ['Road\tTrip'])).out, '1\tRoad Trip\t')
  assert.equal((await create(provider, ['Another'], false, { quiet: true })).out, '2')
})

test('create via the CLI router works end-to-end with the fake provider', async () => {
  const out: string[] = []
  const err: string[] = []
  const code = await cliRun(['--provider', 'fake', '--json', 'playlist', 'create', 'Road Trip', '--public'], {
    io: { out: (m) => out.push(m), err: (m) => err.push(m) },
    env: { SPLE_ENABLE_FAKE_PROVIDER: '1' },
  })
  assert.equal(code, 0)
  assert.equal(JSON.parse(out.join('\n')).public, true)
})

// --- Spotify over mocked HTTP -----------------------------------------------

test('create against Spotify: --dry-run sends no request; real run sends one POST', async (t) => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), 'sple-create-'))
  t.after(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })
  saveTokens(
    'spotify',
    {
      accessToken: 'BQD-access',
      refreshToken: 'AQA-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ['playlist-modify-public', 'playlist-modify-private'],
      userId: 'user123',
      displayName: 'Test User',
      grantedAt: new Date().toISOString(),
    },
    dir
  )
  const calls: FetchCall[] = []
  mockFetch(
    {
      'POST https://api.spotify.com/v1/me/playlists': () =>
        jsonResponse(201, {
          id: 'pl123',
          name: 'Road Trip',
          description: '',
          owner: { id: 'user123', display_name: 'Test User' },
          public: false,
          collaborative: false,
          uri: 'spotify:playlist:pl123',
          external_urls: { spotify: 'https://open.spotify.com/playlist/pl123' },
        }),
    },
    calls
  )
  const provider = createSpotifyProvider('cid', dir)

  const dry = await runCommand(provider, (ctx) => createRun(ctx, ['Road Trip', '--dry-run'], { stdoutIsTTY: true }))
  assert.equal(dry.code, 0)
  assert.equal(calls.length, 0)
  assert.match(dry.out, /^\[dry-run\] Would create private playlist "Road Trip" in Spotify/)

  const real = await runCommand(provider, (ctx) => createRun(ctx, ['Road Trip', '--json'], {}))
  assert.equal(real.code, 0, real.err)
  assert.deepEqual(
    calls.map((c) => c.method),
    ['POST']
  )
  assert.equal(JSON.parse(calls[0].body ?? '{}').public, false)
  const out = JSON.parse(real.out) as PlaylistCreateOutput
  assert.equal(out.dryRun, false)
  assert.equal((out as { id: string }).id, 'pl123')

  const conflict = await runCommand(provider, (ctx) => createRun(ctx, ['X', '--collaborative', '--public'], {}))
  assert.equal(conflict.code, EXIT_CODES.USAGE_ERROR)
  assert.equal(calls.length, 1)
})
