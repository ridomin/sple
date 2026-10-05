import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as listCmd from '../../../../src/cli/commands/playlist/list.js'
import type { PlaylistListOutput } from '../../../../src/cli/output/types.js'
import { EXIT_CODES } from '../../../../src/cli/exit-codes.js'
import { FakeProvider, type FakePlaylist } from '../../../../src/providers/fake/index.js'
import { createSpotifyProvider } from '../../../../src/providers/spotify/index.js'
import { saveTokens } from '../../../../src/core/config/token-store.js'
import { AuthRequiredError } from '../../../../src/core/provider/errors.js'
import type { Page, PageRequest, PlaylistSummary, Provider } from '../../../../src/core/provider/provider.js'
import { runCommand, mockFetch, jsonResponse, type FetchCall } from './helpers.js'

const ME = 'fake-user'

function playlist(id: number, owner = ME, extra: Partial<FakePlaylist> = {}): FakePlaylist {
  return {
    id: String(id),
    name: `Playlist ${id}`,
    owner,
    public: id % 2 === 0,
    collaborative: false,
    trackIds: [],
    ...extra,
  }
}

function fake(playlists: FakePlaylist[]): FakeProvider {
  return new FakeProvider({ initialPlaylists: playlists })
}

/** Records every listPlaylists page request; calls still reach the provider. */
function spyList(provider: Provider, withTotal?: number): PageRequest[] {
  const requests: PageRequest[] = []
  const original = provider.listPlaylists.bind(provider)
  ;(provider as { listPlaylists: Provider['listPlaylists'] }).listPlaylists = async (page, filter) => {
    requests.push(page)
    const result: Page<PlaylistSummary> = await original(page, filter)
    return withTotal === undefined ? result : { ...result, total: withTotal }
  }
  return requests
}

const run = (provider: Provider, args: string[], flags = {}, deps: listCmd.ListDeps = {}) =>
  runCommand(provider, (ctx) => listCmd.run(ctx, args, deps), flags)

test('playlist list (M1-23, FR-PL-1)', async (t) => {
  await t.test('prints one TSV row per playlist with the ADR-0007 column order (stdout not a TTY)', async () => {
    const p = fake([
      playlist(1, ME, { name: 'Road trip', trackIds: ['a', 'b'], public: false }),
      playlist(2, 'someone', { name: 'Theirs', collaborative: true }),
    ])
    const r = await run(p, [])
    assert.equal(r.code, 0)
    assert.deepEqual(r.out.split('\n'), [
      'Road trip\t1\t2\tfake-user\ttrue\tfalse\tfalse',
      'Theirs\t2\t0\tsomeone\tfalse\ttrue\ttrue',
    ])
    assert.equal(r.err, '')
  })

  await t.test('reads every page (sequentially when the provider reports no total)', async () => {
    const all = Array.from({ length: 120 }, (_, i) => playlist(i + 1))
    const p = fake(all)
    const requests = spyList(p)
    const r = await run(p, ['--quiet'])
    assert.equal(r.code, 0)
    assert.deepEqual(r.out.split('\n'), all.map((x) => x.id))
    assert.deepEqual(requests, [
      { limit: 50, offset: 0 },
      { limit: 50, offset: 50 },
      { limit: 50, offset: 100 },
    ])
  })

  await t.test('fetches the remaining pages concurrently when the provider reports a total', async () => {
    const all = Array.from({ length: 160 }, (_, i) => playlist(i + 1))
    const p = fake(all)
    const requests = spyList(p, 160)
    const r = await run(p, ['--json'])
    assert.equal(r.code, 0)
    const out = JSON.parse(r.out) as PlaylistListOutput
    assert.deepEqual(out.playlists.map((x) => x.id), all.map((x) => x.id), 'order preserved')
    assert.deepEqual(requests.map((q) => q.offset).sort((a, b) => a! - b!), [0, 50, 100, 150])
  })

  await t.test('--owned and --followed filter on ownership; together they exit 2', async () => {
    const p = fake([playlist(1), playlist(2, 'other'), playlist(3), playlist(4, 'other')])
    assert.deepEqual((await run(p, ['--owned', '--quiet'])).out.split('\n'), ['1', '3'])
    assert.deepEqual((await run(p, ['--followed', '--quiet'])).out.split('\n'), ['2', '4'])
    const both = await run(p, ['--owned', '--followed'])
    assert.equal(both.code, EXIT_CODES.USAGE_ERROR)
    assert.match(both.err, /--owned and --followed cannot be used together/)
    assert.equal(both.out, '')
  })

  await t.test('--json prints PlaylistListOutput with total = number returned after the filter', async () => {
    const p = fake([playlist(1), playlist(2, 'other')])
    const r = await run(p, ['--json', '--owned'])
    assert.equal(r.code, 0)
    const out = JSON.parse(r.out) satisfies PlaylistListOutput
    assert.equal(out.total, 1)
    assert.equal(out.next, undefined)
    assert.equal(out.playlists[0].id, '1')
    assert.equal(out.playlists[0].owned, true)
  })

  await t.test('--quiet prints IDs that parsePlaylistRef accepts back (pipes into export -)', async () => {
    const p = fake([playlist(7), playlist(8, 'other')])
    const r = await run(p, [], { quiet: true })
    assert.equal(r.code, 0)
    for (const line of r.out.split('\n')) {
      assert.equal(p.parsePlaylistRef(line), line)
    }
  })

  await t.test('--json with --quiet, unknown flags and positionals are usage errors', async () => {
    const p = fake([])
    assert.equal((await run(p, ['--json', '--quiet'])).code, EXIT_CODES.USAGE_ERROR)
    assert.equal((await run(p, ['--bogus'])).code, EXIT_CODES.USAGE_ERROR)
    assert.equal((await run(p, ['extra'])).code, EXIT_CODES.USAGE_ERROR)
  })

  await t.test('an empty library prints nothing on stdout and "No playlists." on stderr', async () => {
    const r = await run(fake([]), [])
    assert.equal(r.code, 0)
    assert.equal(r.out, '')
    assert.equal(r.err, 'No playlists.')
    const j = await run(fake([]), ['--json'])
    assert.deepEqual(JSON.parse(j.out), { playlists: [], total: 0 })
    assert.equal(j.err, '')
  })

  await t.test('provider auth errors exit 3', async () => {
    const p = fake([])
    p.listPlaylists = async () => {
      throw new AuthRequiredError('no token', 'no-token')
    }
    const r = await run(p, [])
    assert.equal(r.code, EXIT_CODES.AUTH_REQUIRED)
    assert.match(r.err, /sple auth login/)
  })

  await t.test('progress is drawn in place on a TTY stderr and cleared at the end', async () => {
    const writes: string[] = []
    const stream = { isTTY: true, write: (s: string) => writes.push(s) }
    const p = fake(Array.from({ length: 120 }, (_, i) => playlist(i + 1)))
    spyList(p, 120)
    const r = await run(p, [], {}, { progressStream: stream })
    assert.equal(r.code, 0)
    assert.ok(writes.some((w) => /Fetching playlists \[#+-*\] \d\/3 pages/.test(w)), writes.join('|'))
    assert.ok(writes.some((w) => w.includes('3/3 pages')), 'final update is always drawn')
    assert.equal(writes.at(-1), '\r\x1b[K')
    assert.ok(writes.every((w) => !w.includes('\n')), 'never writes a newline')
  })

  await t.test('progress is disabled with --json and --quiet', async () => {
    for (const flag of ['--json', '--quiet']) {
      const writes: string[] = []
      const stream = { isTTY: true, write: (s: string) => writes.push(s) }
      await run(fake([playlist(1)]), [flag], {}, { progressStream: stream })
      assert.deepEqual(writes, [], flag)
    }
  })
})

// --- Spotify adapter behind the command (mocked HTTP) ----------------------

const API = 'https://api.spotify.com/v1'
const SPOTIFY_ME = 'testuser0000000000000'

function spotifyPlaylist(n: number, ownerId: string) {
  const id = `pl${String(n).padStart(20, '0')}`
  return {
    id,
    name: `Spotify ${n}`,
    collaborative: false,
    public: false,
    description: '',
    owner: { id: ownerId, display_name: ownerId === SPOTIFY_ME ? 'Test User' : 'Other User' },
    items: { href: `${API}/playlists/${id}/items`, total: n },
    uri: `spotify:playlist:${id}`,
  }
}

test('playlist list against the Spotify adapter (mocked HTTP)', async (t) => {
  const realFetch = globalThis.fetch
  let dir: string
  t.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sple-list-cmd-'))
  })
  t.afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  await t.test('pages through /me/playlists and marks ownership from the token user', async () => {
    saveTokens(
      'spotify',
      {
        accessToken: 'BQD-access',
        refreshToken: 'AQA-refresh',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        scopes: ['playlist-read-private', 'playlist-read-collaborative'],
        userId: SPOTIFY_ME,
        displayName: 'Test User',
        grantedAt: new Date().toISOString(),
      },
      dir
    )
    const total = 120
    const all = Array.from({ length: total }, (_, i) => spotifyPlaylist(i, i % 3 === 0 ? 'someone' : SPOTIFY_ME))
    const calls: FetchCall[] = []
    const routes: Record<string, () => Response> = {}
    for (const offset of [0, 50, 100]) {
      routes[`GET ${API}/me/playlists?limit=50&offset=${offset}`] = () =>
        jsonResponse(200, { items: all.slice(offset, offset + 50), total, limit: 50, offset })
    }
    mockFetch(routes, calls)

    const provider = createSpotifyProvider('cid', dir)
    const r = await run(provider, ['--owned', '--json'])
    assert.equal(r.code, 0, r.err)
    const out = JSON.parse(r.out) as PlaylistListOutput
    assert.equal(out.total, all.filter((_, i) => i % 3 !== 0).length)
    assert.ok(out.playlists.every((p) => p.owned))
    assert.equal(calls.length, 3)
    for (const p of out.playlists) assert.equal(provider.parsePlaylistRef(p.id), p.id)
  })

  await t.test('without a stored token it exits 3 and makes no request', async () => {
    const calls: FetchCall[] = []
    mockFetch({}, calls)
    const r = await run(createSpotifyProvider('cid', dir), [])
    assert.equal(r.code, EXIT_CODES.AUTH_REQUIRED)
    assert.equal(calls.length, 0)
  })
})
