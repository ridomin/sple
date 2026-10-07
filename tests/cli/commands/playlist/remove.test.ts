import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  run as removeRun,
  removeAction,
  removeNotice,
  type RemoveDeps,
} from '../../../../src/cli/commands/playlist/remove.js'
import { EXIT_CODES } from '../../../../src/cli/exit-codes.js'
import type { PlaylistRemoveOutput } from '../../../../src/cli/output/types.js'
import { clearPlaylistCache } from '../../../../src/core/playlist-resolver.js'
import { FakeProvider, type FakePlaylist } from '../../../../src/providers/fake/index.js'
import { createSpotifyProvider } from '../../../../src/providers/spotify/index.js'
import { saveTokens } from '../../../../src/core/config/token-store.js'
import { runCommand, spyWrites, mockFetch, jsonResponse, type FetchCall } from './helpers.js'

const ROAD_TRIP: FakePlaylist = {
  id: '7',
  name: 'Road Trip',
  owner: 'fake-user',
  public: false,
  collaborative: false,
  trackIds: [],
}

function setup(canDeletePlaylist = true) {
  const provider = new FakeProvider({
    capabilities: { canDeletePlaylist },
    initialPlaylists: [{ ...ROAD_TRIP }],
  })
  const writes = spyWrites(provider)
  return { provider, writes }
}

/** Interactive terminal by default; prompts fail the test unless a test supplies one. */
function remove(
  provider: FakeProvider,
  args: string[],
  deps: RemoveDeps = {},
  flags = {}
) {
  const full: RemoveDeps = {
    stdoutIsTTY: false,
    stdinIsTTY: true,
    readRefs: async () => assert.fail('stdin must not be read'),
    prompt: async () => assert.fail('must not prompt'),
    ...deps,
  }
  return runCommand(provider, (ctx) => removeRun(ctx, args, full), flags)
}

async function exists(provider: FakeProvider, id: string): Promise<boolean> {
  return provider.getPlaylist(id).then(
    () => true,
    () => false
  )
}

beforeEach(() => clearPlaylistCache())

// --- confirmation ----------------------------------------------------------

test('remove --yes removes without prompting', async () => {
  const { provider, writes } = setup()
  const r = await remove(provider, ['7', '--yes'])
  assert.equal(r.code, 0, r.err)
  assert.equal(writes.remove, 1)
  assert.equal(await exists(provider, '7'), false)
})

test('global --yes (ctx.yes) also skips the prompt', async () => {
  const { provider, writes } = setup()
  const r = await remove(provider, ['7'], {}, { yes: true })
  assert.equal(r.code, 0, r.err)
  assert.equal(writes.remove, 1)
})

test('remove without --yes on non-TTY stdin exits 2 and makes no API call', async () => {
  const { provider, writes } = setup()
  let reads = 0
  const getPlaylist = provider.getPlaylist.bind(provider)
  provider.getPlaylist = (ref) => {
    reads++
    return getPlaylist(ref)
  }
  const r = await remove(provider, ['7'], { stdinIsTTY: false })
  assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
  assert.match(r.err, /--yes/)
  assert.equal(writes.remove, 0)
  assert.equal(reads, 0)
  assert.equal(await exists(provider, '7'), true)
})

test('remove on a TTY prompts on stderr with the capability notice and removes on yes', async () => {
  const { provider, writes } = setup(false)
  const questions: string[] = []
  const r = await remove(provider, ['Road Trip'], {
    prompt: async (q) => {
      questions.push(q)
      return true
    },
  })
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(questions, ['Unfollow playlist "Road Trip" (7)?'])
  assert.match(r.err, /Fake Provider cannot delete playlists; this unfollows it/)
  assert.equal(writes.remove, 1)
})

test('remove on a TTY aborts with exit 1 and no write when the prompt is declined', async () => {
  const { provider, writes } = setup()
  const r = await remove(provider, ['7'], { prompt: async () => false })
  assert.equal(r.code, EXIT_CODES.ERROR)
  assert.match(r.err, /Aborted/)
  assert.equal(writes.remove, 0)
  assert.equal(await exists(provider, '7'), true)
})

// --- stdin "-" ---------------------------------------------------------------

test('remove - without --yes exits 2 before reading stdin', async () => {
  const { provider, writes } = setup()
  const r = await remove(provider, ['-'], { stdinIsTTY: false })
  assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
  assert.match(r.err, /--yes/)
  assert.equal(writes.remove, 0)
})

test('remove - --yes reads exactly one ref from stdin', async () => {
  const { provider, writes } = setup()
  const r = await remove(provider, ['-', '--yes'], { stdinIsTTY: false, readRefs: async () => ['fake:playlist:7'] })
  assert.equal(r.code, 0, r.err)
  assert.equal(writes.remove, 1)
})

test('remove - with zero or several refs on stdin exits 2', async () => {
  for (const refs of [[], ['7', '8']]) {
    const { provider, writes } = setup()
    const r = await remove(provider, ['-', '--yes'], { stdinIsTTY: false, readRefs: async () => refs })
    assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
    assert.match(r.err, /exactly one/)
    assert.equal(writes.remove, 0)
  }
})

test('remove - with stdin on a terminal exits 2', async () => {
  const { provider } = setup()
  const r = await remove(provider, ['-', '--yes'], { stdinIsTTY: true })
  assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
})

// --- dry run -----------------------------------------------------------------

test('remove --dry-run resolves but makes no write call in every output mode, without --yes', async () => {
  const modes: Array<{ args: string[]; tty?: boolean }> = [
    { args: [] },
    { args: [], tty: true },
    { args: ['--json'] },
    { args: ['--quiet'] },
  ]
  for (const m of modes) {
    const { provider, writes } = setup()
    const r = await remove(provider, ['Road Trip', '--dry-run', ...m.args], {
      stdinIsTTY: false,
      stdoutIsTTY: m.tty ?? false,
    })
    assert.equal(r.code, 0, r.err)
    assert.equal(writes.remove, 0)
    assert.equal(await exists(provider, '7'), true)
  }
})

test('remove --dry-run on a TTY prints a [dry-run] sentence', async () => {
  const { provider } = setup(false)
  const r = await remove(provider, ['7', '--dry-run'], { stdoutIsTTY: true })
  assert.equal(r.out, '[dry-run] Would unfollow playlist "Road Trip" (7) in Fake Provider')
})

test('remove --dry-run in TSV mode keeps the real-run row and says it is a dry run on stderr (#34)', async () => {
  const { provider } = setup()
  const r = await remove(provider, ['7', '--dry-run'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'deleted\t7\tRoad Trip')
  assert.match(r.err, /^\[dry-run\] Would delete playlist "Road Trip" \(7\) in Fake Provider$/m)
  const real = await remove(provider, ['7', '--yes'])
  assert.ok(!real.err.includes('[dry-run]'))
})

test('remove --dry-run --json reports dryRun: true and the planned action', async () => {
  const { provider } = setup()
  const r = await remove(provider, ['7', '--dry-run', '--json'])
  const expected = {
    dryRun: true,
    action: 'deleted',
    playlist: { id: '7', ref: '7', name: 'Road Trip' },
  } satisfies PlaylistRemoveOutput
  assert.deepEqual(JSON.parse(r.out), expected)
})

test('remove --dry-run on an unknown playlist exits 4', async () => {
  const { provider } = setup()
  const r = await remove(provider, ['Nope', '--dry-run'])
  assert.equal(r.code, EXIT_CODES.NOT_FOUND)
})

// --- capability-driven wording ---------------------------------------------

test('action and notice follow canDeletePlaylist, not the provider id', () => {
  const base = { displayName: 'Acme Music' }
  const del = { ...base, capabilities: { canDeletePlaylist: true } } as Parameters<typeof removeNotice>[0]
  const unf = { ...base, capabilities: { canDeletePlaylist: false } } as Parameters<typeof removeNotice>[0]
  assert.equal(removeAction(del), 'deleted')
  assert.equal(removeAction(unf), 'unfollowed')
  assert.equal(removeNotice(del), 'This permanently deletes the playlist from Acme Music.')
  assert.equal(
    removeNotice(unf),
    'Acme Music cannot delete playlists; this unfollows it (removes it from your library). ' +
      'Owned playlists can be restored from your Acme Music account page.'
  )
})

test('same fake provider reports deleted vs unfollowed depending only on capability', async () => {
  for (const [can, action, past] of [
    [true, 'deleted', 'Deleted'],
    [false, 'unfollowed', 'Unfollowed'],
  ] as const) {
    const json = await remove(setup(can).provider, ['7', '--yes', '--json'])
    assert.equal((JSON.parse(json.out) as PlaylistRemoveOutput).action, action)
    const tty = await remove(setup(can).provider, ['7', '--yes'], { stdoutIsTTY: true })
    assert.equal(tty.out, `${past} playlist "Road Trip" (7)`)
  }
})

// --- output modes & validation ----------------------------------------------

test('remove TSV prints action, id, name and --quiet prints the id', async () => {
  assert.equal((await remove(setup().provider, ['7', '--yes'])).out, 'deleted\t7\tRoad Trip')
  assert.equal((await remove(setup().provider, ['7', '--yes', '--quiet'])).out, '7')
})

test('remove --json output satisfies PlaylistRemoveOutput', async () => {
  const r = await remove(setup(false).provider, ['7', '--yes'], {}, { json: true })
  const expected = {
    dryRun: false,
    action: 'unfollowed',
    playlist: { id: '7', ref: '7', name: 'Road Trip' },
  } satisfies PlaylistRemoveOutput
  assert.deepEqual(JSON.parse(r.out), expected)
})

test('remove argument errors exit 2', async () => {
  for (const args of [[], ['7', '8', '--yes'], ['7', '--bogus'], ['7', '--json', '--quiet', '--yes']]) {
    const { provider, writes } = setup()
    const r = await remove(provider, args)
    assert.equal(r.code, EXIT_CODES.USAGE_ERROR, args.join(' '))
    assert.equal(writes.remove, 0)
  }
})

// --- Spotify over mocked HTTP -----------------------------------------------

const __dirname = join(fileURLToPath(import.meta.url), '..')
const OWNED_ID = '0FRr10mglUR3E0Pq8TqlxL'

test('remove against Spotify: dry run is GET-only; --yes unfollows with one DELETE', async (t) => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), 'sple-remove-'))
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
      scopes: [
        'playlist-read-private',
        'playlist-read-collaborative',
        'playlist-modify-public',
        'playlist-modify-private',
      ],
      userId: 'testuser0000000000000',
      displayName: 'Test User',
      grantedAt: new Date().toISOString(),
    },
    dir
  )
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '..', '..', '..', 'fixtures', 'spotify', 's2-owned-pl.json'), 'utf-8')
  ) as { body: { name: string } }
  const calls: FetchCall[] = []
  const uri = encodeURIComponent(`spotify:playlist:${OWNED_ID}`)
  mockFetch(
    {
      [`GET https://api.spotify.com/v1/playlists/${OWNED_ID}`]: () => jsonResponse(200, fixture.body),
      [`DELETE https://api.spotify.com/v1/me/library?uris=${uri}`]: () => new Response(null, { status: 200 }),
    },
    calls
  )
  const provider = createSpotifyProvider('cid', dir)
  const url = `https://open.spotify.com/playlist/${OWNED_ID}`

  const noYes = await runCommand(provider, (ctx) => removeRun(ctx, [url], { stdinIsTTY: false }))
  assert.equal(noYes.code, EXIT_CODES.USAGE_ERROR)
  assert.equal(calls.length, 0)

  const dry = await runCommand(provider, (ctx) =>
    removeRun(ctx, [url, '--dry-run'], { stdinIsTTY: false, stdoutIsTTY: true })
  )
  assert.equal(dry.code, 0, dry.err)
  assert.deepEqual(
    calls.map((c) => c.method),
    ['GET']
  )
  assert.equal(dry.out, `[dry-run] Would unfollow playlist "${fixture.body.name}" (${OWNED_ID}) in Spotify`)
  assert.match(dry.err, /Spotify cannot delete playlists; this unfollows it \(removes it from your library\)\./)

  calls.length = 0
  const real = await runCommand(provider, (ctx) => removeRun(ctx, [url, '--yes', '--json'], { stdinIsTTY: false }))
  assert.equal(real.code, 0, real.err)
  assert.deepEqual(
    calls.map((c) => c.method),
    ['GET', 'DELETE']
  )
  assert.equal((JSON.parse(real.out) as PlaylistRemoveOutput).action, 'unfollowed')
})
