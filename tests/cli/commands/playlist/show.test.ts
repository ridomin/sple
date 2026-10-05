import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as showCmd from '../../../../src/cli/commands/playlist/show.js'
import * as listCmd from '../../../../src/cli/commands/playlist/list.js'
import type { PlaylistShowOutput } from '../../../../src/cli/output/types.js'
import { EXIT_CODES } from '../../../../src/cli/exit-codes.js'
import { FakeProvider, type FakePlaylist, type FakeTrack } from '../../../../src/providers/fake/index.js'
import { createSpotifyProvider } from '../../../../src/providers/spotify/index.js'
import { saveTokens } from '../../../../src/core/config/token-store.js'
import { clearPlaylistCache } from '../../../../src/core/playlist-resolver.js'
import type { ProviderCapabilities } from '../../../../src/core/provider/capabilities.js'
import type { PageRequest, Provider } from '../../../../src/core/provider/provider.js'
import { runCommand, mockFetch, jsonResponse, type FetchCall } from './helpers.js'

const ME = 'fake-user'

function tracks(n: number): FakeTrack[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `Song ${i + 1}`,
    artists: ['Artist A', 'Artist B'],
    album: `Album ${i + 1}`,
    duration: 185_000 + i,
  }))
}

function playlist(id: string, extra: Partial<FakePlaylist> = {}): FakePlaylist {
  return { id, name: `Playlist ${id}`, owner: ME, public: false, collaborative: false, trackIds: [], ...extra }
}

function fake(
  playlists: FakePlaylist[],
  trackList: FakeTrack[] = [],
  capabilities: Partial<ProviderCapabilities> = {}
): FakeProvider {
  return new FakeProvider({ initialPlaylists: playlists, initialTracks: trackList, capabilities })
}

/** Records getPlaylistTracks page requests; calls still reach the provider. */
function spyTracks(provider: Provider): PageRequest[] {
  const requests: PageRequest[] = []
  const original = provider.getPlaylistTracks.bind(provider)
  ;(provider as { getPlaylistTracks: Provider['getPlaylistTracks'] }).getPlaylistTracks = (ref, page) => {
    requests.push(page)
    return original(ref, page)
  }
  return requests
}

const run = (provider: Provider, args: string[], flags = {}, deps: showCmd.ShowDeps = {}) =>
  runCommand(provider, (ctx) => showCmd.run(ctx, args, deps), flags)

test('playlist show (M1-23, FR-PL-2)', async (t) => {
  t.beforeEach(() => clearPlaylistCache())

  await t.test('prints TSV rows: #, title, artists, album, duration, added at (ISO UTC), id', async () => {
    const p = fake([playlist('1', { trackIds: ['t1', 't2'] })], tracks(2))
    const r = await run(p, ['1'])
    assert.equal(r.code, 0, r.err)
    const lines = r.out.split('\n')
    assert.equal(lines.length, 2)
    const [pos, title, artists, album, duration, addedAt, id] = lines[0].split('\t')
    assert.deepEqual([pos, title, artists, album, duration, id], ['1', 'Song 1', 'Artist A, Artist B', 'Album 1', '3:05', 't1'])
    assert.match(addedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.equal(lines[1].split('\t')[0], '2')
    assert.equal(r.err, '')
  })

  await t.test('resolves a URI and an exact name (case-insensitive fallback)', async () => {
    const p = fake([playlist('5', { name: 'Road Trip', trackIds: ['t1'] })], tracks(1))
    assert.equal((await run(p, ['fake:playlist:5', '--quiet'])).out, 't1')
    clearPlaylistCache()
    assert.equal((await run(p, ['road trip', '--quiet'])).out, 't1')
  })

  await t.test('an ambiguous name exits 2 and lists every match with its owner', async () => {
    const p = fake([
      playlist('1', { name: 'Mix' }),
      playlist('2', { name: 'Mix', owner: 'alice' }),
      playlist('3', { name: 'Other' }),
    ])
    const r = await run(p, ['Mix'])
    assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
    assert.equal(r.out, '')
    assert.match(r.err, /Multiple playlists matched "Mix"/)
    assert.match(r.err, /id: 1, owner: fake-user \(owned\)/)
    assert.match(r.err, /id: 2, owner: alice\)/)
    assert.doesNotMatch(r.err, /id: 3/)
  })

  await t.test('an unknown name exits 4', async () => {
    const r = await run(fake([playlist('1')]), ['Nope'])
    assert.equal(r.code, EXIT_CODES.NOT_FOUND)
  })

  await t.test('a not-owned playlist exits 1 with the workaround, before any track request', async () => {
    const p = fake([playlist('9', { name: 'Their mix', owner: 'alice', trackIds: ['t1'] })], tracks(1), {
      playlistItemsAccess: 'owned-only',
    })
    const requests = spyTracks(p)
    const r = await run(p, ['9'])
    assert.equal(r.code, EXIT_CODES.ERROR)
    assert.equal(r.out, '')
    assert.match(r.err, /cannot read the tracks of "Their mix" \(owned by alice\)/)
    assert.match(r.err, /only returns the tracks of playlists you own\./)
    assert.match(r.err, /Workaround: .*copy its tracks into a playlist you own/)
    assert.equal(requests.length, 0)
  })

  await t.test('owned-or-collaborator wording mentions collaboration', async () => {
    const p = fake([playlist('9', { owner: 'alice' })], [], { playlistItemsAccess: 'owned-or-collaborator' })
    const r = await run(p, ['9', '--json'])
    assert.equal(r.code, EXIT_CODES.ERROR)
    assert.match(r.err, /playlists you own or collaborate on/)
    assert.equal(r.out, '')
  })

  await t.test('a readable playlist owned by someone else notes collaborator access', async () => {
    const p = fake([playlist('9', { name: 'Shared', owner: 'alice', collaborative: true, trackIds: ['t1'] })], tracks(1), {
      playlistItemsAccess: 'owned-or-collaborator',
    })
    const r = await run(p, ['9', '--quiet'])
    assert.equal(r.code, 0)
    assert.equal(r.out, 't1')
    assert.match(r.err, /"Shared" is owned by alice; readable via collaborator access/)
  })

  await t.test('reads every page of tracks at maxTracksPerRequest, in order', async () => {
    const all = tracks(250)
    const p = fake([playlist('1', { trackIds: all.map((x) => x.id) })], all)
    const requests = spyTracks(p)
    const r = await run(p, ['1', '--quiet'])
    assert.equal(r.code, 0)
    assert.deepEqual(r.out.split('\n'), all.map((x) => x.id))
    assert.deepEqual(requests, [
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
      { limit: 100, offset: 200 },
    ])
  })

  await t.test('--json prints PlaylistShowOutput with 1-based positions', async () => {
    const p = fake([playlist('1', { name: 'J', trackIds: ['t1', 't2', 't3'] })], tracks(3))
    const r = await run(p, ['1'], { json: true })
    assert.equal(r.code, 0)
    const out = JSON.parse(r.out) satisfies PlaylistShowOutput
    assert.equal(out.playlist.name, 'J')
    assert.deepEqual(out.tracks.map((x: { position: number }) => x.position), [1, 2, 3])
    assert.equal(out.tracks[0].refs.fake, 't1')
    assert.deepEqual(out.unsupportedItems, [])
  })

  await t.test('warns on stderr when the provider total exceeds the supported tracks', async () => {
    const p = fake([playlist('1', { name: 'Mixed', trackIds: ['t1', 't2'] })], tracks(2))
    const original = p.getPlaylistTracks.bind(p)
    p.getPlaylistTracks = async (ref, page) => ({ ...(await original(ref, page)), total: 5 })
    const r = await run(p, ['1', '--quiet'])
    assert.equal(r.code, 0)
    assert.equal(r.out, 't1\nt2')
    assert.match(r.err, /warning: 3 of 5 items in "Mixed" are not supported/)
  })

  await t.test('an empty playlist prints nothing on stdout and a notice on stderr', async () => {
    const r = await run(fake([playlist('1', { name: 'Empty' })]), ['1'])
    assert.equal(r.code, 0)
    assert.equal(r.out, '')
    assert.match(r.err, /"Empty" has no tracks/)
  })

  await t.test('"-" reads exactly one ref from stdin', async () => {
    const p = fake([playlist('1', { trackIds: ['t1'] })], tracks(1))
    const ok = await run(p, ['-', '--quiet'], {}, { readRefs: async () => ['1'] })
    assert.equal(ok.code, 0)
    assert.equal(ok.out, 't1')
    for (const refs of [[], ['1', '1']]) {
      const r = await run(p, ['-'], {}, { readRefs: async () => refs })
      assert.equal(r.code, EXIT_CODES.USAGE_ERROR, JSON.stringify(refs))
      assert.match(r.err, /exactly one playlist ref on stdin/)
    }
  })

  await t.test('playlist list --quiet output feeds "-" (pipe contract)', async () => {
    const p = fake([playlist('3', { name: 'Only', trackIds: ['t2'] })], tracks(2))
    const listed = await runCommand(p, (ctx) => listCmd.run(ctx, ['--quiet']))
    const refs = listed.out.split('\n')
    const r = await run(p, ['-', '--quiet'], {}, { readRefs: async () => refs })
    assert.equal(r.code, 0)
    assert.equal(r.out, 't2')
  })

  await t.test('usage errors exit 2: no playlist, two playlists, --json with --quiet, unknown flag', async () => {
    const p = fake([playlist('1')])
    for (const args of [[], ['1', '2'], ['1', '--json', '--quiet'], ['1', '--bogus']]) {
      assert.equal((await run(p, args)).code, EXIT_CODES.USAGE_ERROR, args.join(' '))
    }
  })

  await t.test('progress reports tracks on a TTY stderr and is cleared before warnings', async () => {
    const writes: string[] = []
    const stream = { isTTY: true, write: (s: string) => writes.push(s) }
    const all = tracks(150)
    const p = fake([playlist('1', { name: 'Big', trackIds: all.map((x) => x.id) })], all)
    const r = await run(p, ['1'], {}, { progressStream: stream })
    assert.equal(r.code, 0)
    assert.ok(writes.some((w) => w.includes('Reading "Big"') && w.includes('tracks')), writes.join('|'))
    assert.equal(writes.at(-1), '\r\x1b[K')
  })
})

test('formatDuration uses m:ss and h:mm:ss from one hour', () => {
  assert.equal(showCmd.formatDuration(0), '0:00')
  assert.equal(showCmd.formatDuration(185_000), '3:05')
  assert.equal(showCmd.formatDuration(3_600_000), '1:00:00')
  assert.equal(showCmd.formatDuration(3_725_000), '1:02:05')
  assert.equal(showCmd.formatDuration(undefined), '')
})

// --- Spotify adapter behind the command (recorded S2 fixtures) -------------

const API = 'https://api.spotify.com/v1'
const SPOTIFY_ME = 'testuser0000000000000'
const OWNED_ID = '0FRr10mglUR3E0Pq8TqlxL'
const FOLLOWED_ID = '76IBoRDyYzi2Svw7oRRfki'
const FIXTURES = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'fixtures', 'spotify')

interface Recorded {
  status: number
  body: Record<string, unknown>
}
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8')) as Recorded

test('playlist show against the Spotify adapter (recorded fixtures)', async (t) => {
  const realFetch = globalThis.fetch
  let dir: string
  t.beforeEach(() => {
    clearPlaylistCache()
    dir = mkdtempSync(join(tmpdir(), 'sple-show-cmd-'))
    saveTokens(
      'spotify',
      {
        accessToken: 'BQD-access',
        refreshToken: 'AQA-refresh',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        scopes: ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read'],
        userId: SPOTIFY_ME,
        displayName: 'Test User',
        grantedAt: new Date().toISOString(),
      },
      dir
    )
  })
  t.afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  await t.test('an owned playlist shows its tracks; --quiet prints Spotify track URIs', async () => {
    const items = fixture('s2-owned-items.json').body as { items: unknown[] }
    // Recorded with limit=2; make it a complete one-page playlist.
    const page = { ...items, total: items.items.length }
    const calls: FetchCall[] = []
    mockFetch(
      {
        [`GET ${API}/playlists/${OWNED_ID}`]: () => jsonResponse(200, fixture('s2-owned-pl.json').body),
        [`GET ${API}/playlists/${OWNED_ID}/items?limit=100&offset=0`]: () => jsonResponse(200, page),
      },
      calls
    )
    const provider = createSpotifyProvider('cid', dir)

    const json = await run(provider, [`spotify:playlist:${OWNED_ID}`, '--json'])
    assert.equal(json.code, 0, json.err)
    const out = JSON.parse(json.out) as PlaylistShowOutput
    assert.equal(out.playlist.id, OWNED_ID)
    assert.equal(out.playlist.owned, true)
    assert.equal(out.tracks.length, 2)
    assert.equal(out.tracks[0].addedAt, '2026-04-15T12:28:26Z')
    assert.equal(json.err, '')

    const quiet = await run(provider, [OWNED_ID, '--quiet'])
    assert.deepEqual(quiet.out.split('\n'), out.tracks.map((x) => x.refs.spotify))
  })

  await t.test('a followed playlist owned by someone else exits 1 with no /items request', async () => {
    const body = fixture('s2-followed-pl.json').body as { owner: Record<string, unknown> }
    const other = { ...body, owner: { ...body.owner, id: 'otheruser000000000000', display_name: 'Other User' } }
    const calls: FetchCall[] = []
    mockFetch({ [`GET ${API}/playlists/${FOLLOWED_ID}`]: () => jsonResponse(200, other) }, calls)

    const r = await run(createSpotifyProvider('cid', dir), [`https://open.spotify.com/playlist/${FOLLOWED_ID}`])
    assert.equal(r.code, EXIT_CODES.ERROR)
    assert.equal(r.out, '')
    assert.match(r.err, /owned by Other User/)
    assert.match(r.err, /Spotify only returns the tracks of playlists you own or collaborate on/)
    assert.match(r.err, /Workaround/)
    assert.ok(!calls.some((c) => c.url.includes('/items')), '/items must never be requested')
  })

  await t.test('local files are counted in a stderr warning', async () => {
    const items = fixture('s2-owned-items.json').body as { items: unknown[] }
    const local = {
      added_at: '2026-04-15T12:30:00Z',
      is_local: true,
      item: { type: 'track', id: null, name: 'Home recording', uri: 'spotify:local:::Home+recording:200', is_local: true },
    }
    const page = { ...items, items: [...items.items, local], total: items.items.length + 1 }
    mockFetch(
      {
        [`GET ${API}/playlists/${OWNED_ID}`]: () => jsonResponse(200, fixture('s2-owned-pl.json').body),
        [`GET ${API}/playlists/${OWNED_ID}/items?limit=100&offset=0`]: () => jsonResponse(200, page),
      },
      []
    )
    const r = await run(createSpotifyProvider('cid', dir), [OWNED_ID, '--quiet'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out.split('\n').length, 2)
    assert.match(r.err, /warning: 1 of 3 items in ".*" are not supported/)
  })

  await t.test('without a stored token it exits 3', async () => {
    rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), 'sple-show-cmd-'))
    const calls: FetchCall[] = []
    mockFetch({}, calls)
    const r = await run(createSpotifyProvider('cid', dir), [OWNED_ID])
    assert.equal(r.code, EXIT_CODES.AUTH_REQUIRED)
    assert.equal(calls.length, 0)
  })
})
