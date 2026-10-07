import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as exportCmd from '../../../src/cli/commands/export.js'
import * as listCmd from '../../../src/cli/commands/playlist/list.js'
import type { ExportOutput } from '../../../src/cli/output/types.js'
import { EXIT_CODES } from '../../../src/cli/exit-codes.js'
import { FakeProvider, type FakePlaylist, type FakeTrack } from '../../../src/providers/fake/index.js'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'
import { saveTokens } from '../../../src/core/config/token-store.js'
import { clearPlaylistCache } from '../../../src/core/playlist-resolver.js'
import type { ProviderCapabilities } from '../../../src/core/provider/capabilities.js'
import { AuthRequiredError } from '../../../src/core/provider/errors.js'
import type { CanonicalPlaylistFile } from '../../../src/core/export/format.js'
import type { Provider } from '../../../src/core/provider/provider.js'
import { runCommand, mockFetch, jsonResponse, type FetchCall } from './playlist/helpers.js'
import { schemaErrors } from '../../core/export/helpers.js'

const ME = 'fake-user'

function tracks(n: number): FakeTrack[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `Song ${i + 1}`,
    artists: ['Artist A'],
    album: 'Album',
    duration: 180_000,
  }))
}

function playlist(id: string, extra: Partial<FakePlaylist> = {}): FakePlaylist {
  return { id, name: `Playlist ${id}`, owner: ME, public: false, collaborative: false, trackIds: [], ...extra }
}

function fake(playlists: FakePlaylist[], trackList: FakeTrack[] = tracks(5), capabilities: Partial<ProviderCapabilities> = {}) {
  return new FakeProvider({ initialPlaylists: playlists, initialTracks: trackList, capabilities })
}

const run = (provider: Provider, args: string[], flags = {}, deps: exportCmd.ExportDeps = {}) =>
  runCommand(provider, (ctx) => exportCmd.run(ctx, args, { stdoutIsTTY: false, ...deps }), flags)

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sple-export-'))
}

/** No temp files may be left behind by atomic writes. */
function assertNoTempFiles(dir: string): void {
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [])
}

test('sple export (M1-26, FR-EXP-1/2/3/6)', async (t) => {
  t.beforeEach(() => clearPlaylistCache())

  await t.test('one playlist, no -o: stdout is a schema-valid canonical JSON file', async () => {
    const p = fake([playlist('1', { name: 'Road Trip', trackIds: ['t1', 't2', 't3'] })])
    const r = await run(p, ['Road Trip'])
    assert.equal(r.code, 0, r.err)
    const file = JSON.parse(r.out) as CanonicalPlaylistFile
    assert.deepEqual(schemaErrors(file), [])
    assert.equal(file.source.provider, 'fake')
    assert.equal(file.source.kind, 'playlist')
    assert.equal(file.playlist.name, 'Road Trip')
    assert.equal(file.playlist.trackCount, 3)
    assert.deepEqual(file.tracks.map((x) => x.position), [1, 2, 3])
    assert.deepEqual(file.tracks.map((x) => x.refs.fake), ['fake:track:t1', 'fake:track:t2', 'fake:track:t3'])
  })

  await t.test('--format csv to stdout: RFC 4180 with CRLF', async () => {
    const p = fake([playlist('1', { trackIds: ['t1', 't2'] })])
    const r = await run(p, ['1', '--format', 'csv'])
    assert.equal(r.code, 0, r.err)
    const lines = r.out.split('\r\n')
    assert.equal(lines[0], 'position,title,artists,album,duration_ms,added_at,isrc,ref')
    assert.match(lines[1], /^1,Song 1,Artist A,Album,180000,/)
  })

  await t.test('one playlist, -o file: written atomically, path printed', async () => {
    const dir = tempDir()
    try {
      const target = join(dir, 'out.csv')
      const p = fake([playlist('1', { trackIds: ['t1'] })])
      const r = await run(p, ['1', '-o', target, '--format', 'csv'])
      assert.equal(r.code, 0, r.err)
      assert.match(readFileSync(target, 'utf-8'), /^position,title/)
      assert.deepEqual(r.out.split('\t'), [target, 'csv', '1'])
      assertNoTempFiles(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await t.test('several sources need -o <dir> (exit 2); with it, files are <slug>-<id>.<ext>', async () => {
    const p = fake([
      playlist('1', { name: 'Road Trip!', trackIds: ['t1'] }),
      playlist('2', { name: 'Café Mix', trackIds: ['t2', 't3'] }),
    ])
    const noDir = await run(p, ['1', '2'])
    assert.equal(noDir.code, EXIT_CODES.USAGE_ERROR)
    assert.equal(noDir.out, '')

    const root = tempDir()
    try {
      const dir = join(root, 'exports') // created on demand
      const r = await run(p, ['1', '2', '-o', dir, '--quiet'])
      assert.equal(r.code, 0, r.err)
      assert.deepEqual(readdirSync(dir).sort(), ['cafe-mix-2.json', 'road-trip-1.json'])
      assert.deepEqual(r.out.split('\n'), [join(dir, 'road-trip-1.json'), join(dir, 'cafe-mix-2.json')])
      const file = JSON.parse(readFileSync(join(dir, 'cafe-mix-2.json'), 'utf-8')) as CanonicalPlaylistFile
      assert.deepEqual(schemaErrors(file), [])
      assert.equal(file.playlist.trackCount, 2)
      assertNoTempFiles(dir)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await t.test('an existing file is not overwritten without --force (exit 2); --force replaces it', async () => {
    const dir = tempDir()
    try {
      const target = join(dir, 'a.json')
      writeFileSync(target, 'keep me')
      const p = fake([playlist('1', { trackIds: ['t1'] })])
      const r = await run(p, ['1', '-o', target])
      assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
      assert.match(r.err, /already exists; use --force/)
      assert.equal(readFileSync(target, 'utf-8'), 'keep me')

      const forced = await run(p, ['1', '-o', target, '--force'])
      assert.equal(forced.code, 0, forced.err)
      assert.equal((JSON.parse(readFileSync(target, 'utf-8')) as CanonicalPlaylistFile).tracks.length, 1)
      assertNoTempFiles(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await t.test('an existing file in a multi-export is a usage error before anything is written', async () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'playlist-2-2.json'), 'old')
      const p = fake([playlist('1', { trackIds: ['t1'] }), playlist('2', { trackIds: ['t1'] })])
      const r = await run(p, ['1', '2', '-o', dir])
      assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
      assert.ok(!existsSync(join(dir, 'playlist-1-1.json')), 'nothing written')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await t.test('--all is not in M1: exit 2 naming a later release', async () => {
    const r = await run(fake([]), ['--all', '-o', 'x'])
    assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
    assert.match(r.err, /later release/)
  })

  await t.test('usage errors: bad --format, no source, --json to stdout, "-" combined', async () => {
    const p = fake([playlist('1')])
    for (const args of [['1', '--format', 'xml'], [], ['1', '--json'], ['-', '1'], ['-', '-']]) {
      const r = await run(p, args)
      assert.equal(r.code, EXIT_CODES.USAGE_ERROR, args.join(' '))
      assert.equal(r.out, '')
    }
  })

  await t.test('an ambiguous name exits 2 and writes nothing', async () => {
    const dir = tempDir()
    try {
      const p = fake([playlist('1', { name: 'Mix' }), playlist('2', { name: 'Mix' }), playlist('3')])
      const r = await run(p, ['3', 'Mix', '-o', dir])
      assert.equal(r.code, EXIT_CODES.USAGE_ERROR)
      assert.match(r.err, /Multiple playlists matched "Mix"/)
      assert.deepEqual(readdirSync(dir), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await t.test('readable + not-owned + missing: readable written, rest skipped, exit by priority, summary', async () => {
    const dir = tempDir()
    try {
      const p = fake(
        [
          playlist('1', { name: 'Mine', trackIds: ['t1', 't2'] }),
          playlist('2', { name: 'Theirs', owner: 'alice', trackIds: ['t1'] }),
        ],
        tracks(2),
        { playlistItemsAccess: 'owned-only' }
      )
      // not-owned only → exit 1
      const r1 = await run(p, ['1', '2', '-o', dir])
      assert.equal(r1.code, EXIT_CODES.ERROR)
      assert.ok(existsSync(join(dir, 'mine-1.json')))
      assert.ok(!existsSync(join(dir, 'theirs-2.json')))
      assert.match(r1.err, /skipped "2": .*cannot read the tracks of "Theirs".*Workaround/)
      assert.match(r1.err, /sple: exported 1 of 2 playlists; 1 skipped \(see above\)/)

      // plus a missing playlist (exit 4 outranks 1); --json carries skipped + PartialFailure
      clearPlaylistCache()
      const r2 = await run(p, ['1', '2', 'fake:playlist:99', '-o', dir, '--force', '--json'])
      assert.equal(r2.code, EXIT_CODES.NOT_FOUND)
      const out = JSON.parse(r2.out) as ExportOutput
      assert.equal(out.files.length, 1)
      assert.equal(out.files[0].source.id, '1')
      assert.deepEqual(out.skipped.map((s) => [s.input, s.error.exitCode]).sort(), [
        ['2', 1],
        ['fake:playlist:99', 4],
      ])
      const lastErr = JSON.parse(r2.err.split('\n').at(-1)!)
      assert.equal(lastErr.error.type, 'PartialFailure')
      assert.equal(lastErr.error.exitCode, EXIT_CODES.NOT_FOUND)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await t.test('an auth error stops the remaining items, which are reported as skipped (exit 3)', async () => {
    const dir = tempDir()
    try {
      const p = fake([playlist('1', { trackIds: ['t1'] }), playlist('2', { trackIds: ['t1'] }), playlist('3', { trackIds: ['t1'] })])
      let n = 0
      const original = p.getPlaylistTracks.bind(p)
      p.getPlaylistTracks = (ref, page) => {
        if (ref === '2') n++
        return ref === '2' ? Promise.reject(new AuthRequiredError('expired', 'revoked')) : original(ref, page)
      }
      const r = await run(p, ['1', '2', '3', '-o', dir, '--json'])
      assert.equal(r.code, EXIT_CODES.AUTH_REQUIRED)
      const out = JSON.parse(r.out) as ExportOutput
      assert.deepEqual(out.files.map((f) => f.source.id), ['1'])
      assert.deepEqual(out.skipped.map((s) => s.input), ['2', '3'])
      assert.equal(n, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await t.test('"playlist list --quiet | export - -o dir/" round-trips', async () => {
    const root = tempDir()
    try {
      const p = fake([playlist('1', { trackIds: ['t1'] }), playlist('2', { name: 'Other', trackIds: ['t2'] })])
      const listed = await runCommand(p, (ctx) => listCmd.run(ctx, []), { quiet: true })
      assert.equal(listed.code, 0)
      const refs = listed.out.split('\n')
      const r = await run(p, ['-', '-o', `${root}/out/`], {}, { readRefs: async () => refs })
      assert.equal(r.code, 0, r.err)
      assert.deepEqual(readdirSync(join(root, 'out')).sort(), ['other-2.json', 'playlist-1-1.json'])

      const empty = await run(p, ['-', '-o', root], {}, { readRefs: async () => [] })
      assert.equal(empty.code, EXIT_CODES.USAGE_ERROR)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await t.test('--liked writes liked-songs.<ext> with source.kind "liked"', async () => {
    const root = tempDir()
    try {
      const r = await run(fake([]), ['--liked', '-o', `${root}/`])
      assert.equal(r.code, 0, r.err)
      const file = JSON.parse(readFileSync(join(root, 'liked-songs.json'), 'utf-8')) as CanonicalPlaylistFile
      assert.deepEqual(schemaErrors(file), [])
      assert.equal(file.source.kind, 'liked')
      assert.equal(file.playlist.name, 'Liked Songs')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  await t.test('slugify and file names', () => {
    assert.equal(exportCmd.slugify('Road Trip!'), 'road-trip')
    assert.equal(exportCmd.slugify('Café — Été 2026'), 'cafe-ete-2026')
    assert.equal(exportCmd.slugify('🎵🎵'), 'playlist')
    assert.ok(exportCmd.slugify('x'.repeat(100)).length <= 60)
  })

  await t.test('writeFileAtomic leaves no temp file when the target exists', () => {
    const dir = tempDir()
    try {
      const target = join(dir, 'f.json')
      writeFileSync(target, 'old')
      assert.throws(() => exportCmd.writeFileAtomic(target, 'new', false), /already exists/)
      assert.equal(readFileSync(target, 'utf-8'), 'old')
      assertNoTempFiles(dir)
      mkdirSync(join(dir, 'sub'))
      exportCmd.writeFileAtomic(join(dir, 'sub', 'g.json'), 'x', false)
      assert.equal(readFileSync(join(dir, 'sub', 'g.json'), 'utf-8'), 'x')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await t.test('partialFailureExitCode orders 3 > 5 > 4 > 1', () => {
    assert.equal(exportCmd.partialFailureExitCode([]), 0)
    assert.equal(exportCmd.partialFailureExitCode([1, 4]), 4)
    assert.equal(exportCmd.partialFailureExitCode([4, 5, 1]), 5)
    assert.equal(exportCmd.partialFailureExitCode([1, 5, 3]), 3)
  })
})

// --- Spotify adapter behind the command (mocked HTTP) ----------------------

const API = 'https://api.spotify.com/v1'
const SP_ME = 'testuser0000000000000'
const PL = '0FRr10mglUR3E0Pq8TqlxL'

function spotifyTrackItem(n: number) {
  return {
    added_at: '2026-01-02T03:04:05Z',
    is_local: false,
    item: {
      type: 'track',
      id: `id${n}`,
      name: `Track ${n}`,
      uri: `spotify:track:id${n}`,
      artists: [{ name: 'Artist' }],
      album: { name: 'Album' },
      duration_ms: 200_000,
    },
  }
}

test('sple export against the Spotify adapter', async (t) => {
  const realFetch = globalThis.fetch
  let dir: string
  t.beforeEach(() => {
    clearPlaylistCache()
    dir = tempDir()
  })
  t.afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const login = (scopes: string[]) =>
    saveTokens(
      'spotify',
      {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes,
        userId: SP_ME,
        grantedAt: '2026-10-01T00:00:00.000Z',
      },
      dir
    )

  await t.test('a 1,000-track playlist exports in under 2 s', async () => {
    login(['playlist-read-private', 'playlist-read-collaborative'])
    const calls: FetchCall[] = []
    const routes: Record<string, (c: FetchCall) => Response> = {
      [`GET ${API}/playlists/${PL}`]: () =>
        jsonResponse(200, { id: PL, name: 'Big', owner: { id: SP_ME }, items: { total: 1000 } }),
    }
    for (let offset = 0; offset < 1000; offset += 100) {
      routes[`GET ${API}/playlists/${PL}/items?limit=100&offset=${offset}`] = () =>
        jsonResponse(200, {
          items: Array.from({ length: 100 }, (_, i) => spotifyTrackItem(offset + i)),
          total: 1000,
        })
    }
    mockFetch(routes, calls)

    const out = join(dir, 'big.json')
    const start = Date.now()
    const r = await run(createSpotifyProvider('cid', dir), [PL, '-o', out])
    const elapsed = Date.now() - start
    assert.equal(r.code, 0, r.err)
    assert.ok(elapsed < 2000, `took ${elapsed}ms`)

    const file = JSON.parse(readFileSync(out, 'utf-8')) as CanonicalPlaylistFile
    assert.deepEqual(schemaErrors(file), [])
    assert.equal(file.tracks.length, 1000)
    assert.equal(file.tracks[999].refs.spotify, 'spotify:track:id999')
    assert.equal(file.tracks[0].addedAt, '2026-01-02T03:04:05Z')
    assert.equal(file.source.userId, SP_ME)
    // One playlist read for the access check, then 10 item pages.
    assert.equal(calls.length, 11)
  })

  await t.test('--liked without user-library-read → exit 3 and no request', async () => {
    login(['playlist-read-private'])
    const calls: FetchCall[] = []
    mockFetch({}, calls)
    const r = await run(createSpotifyProvider('cid', dir), ['--liked'])
    assert.equal(r.code, EXIT_CODES.AUTH_REQUIRED)
    assert.match(r.err, /user-library-read/)
    assert.equal(calls.length, 0)
  })
})
