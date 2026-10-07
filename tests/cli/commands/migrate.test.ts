import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, likedPlaylistName, type MigrateOutput } from '../../../src/cli/commands/migrate.js'
import type { CommandContext } from '../../../src/cli/cli.js'
import { EXIT_CODES } from '../../../src/cli/exit-codes.js'
import { FakeProvider } from '../../../src/providers/fake/index.js'
import { QuotaExhaustedError, UsageError } from '../../../src/core/provider/errors.js'

const track = (id: string, n: number) => ({ id, title: `Song ${n}`, artists: ['A'], duration: 1000 })

/**
 * A "spotify" source with two playlists (Road trip: songs 1–2, Chill: song 3)
 * and a "youtube-music" target whose catalog has all three songs. Both are
 * FakeProviders; the target adds one track per request.
 */
function setup() {
  const source = new FakeProvider({
    userId: 'me',
    initialTracks: [track('s1', 1), track('s2', 2), track('s3', 3)],
    initialPlaylists: [
      { id: '1', name: 'Road trip', owner: 'me', public: false, collaborative: false, trackIds: ['s1', 's2'] },
      { id: '2', name: 'Chill', owner: 'me', public: false, collaborative: false, trackIds: ['s3'] },
    ],
  })
  ;(source as any).id = 'spotify'
  const target = new FakeProvider({
    capabilities: { maxTracksPerRequest: 1 },
    initialTracks: [track('t1', 1), track('t2', 2), track('t3', 3)],
  })
  ;(target as any).id = 'youtube-music'
  const out: string[] = []
  const err: string[] = []
  const ctx = {
    registry: {
      has: (id: string) => id === 'spotify' || id === 'youtube-music',
      list: () => ['spotify', 'youtube-music'],
      create: (id: string) => (id === 'spotify' ? source : target),
      trackRefParsers: () => ({}),
    },
    config: { provider: 'spotify', verbose: false, configDir: mkdtempSync(join(tmpdir(), 'sple-migrate-')) },
    io: { out: (m: string) => out.push(m), err: (m: string) => err.push(m) },
    version: '0.1.0',
    json: false,
    quiet: false,
    debug: false,
    yes: false,
  } as unknown as CommandContext
  const created = async () => (await target.listPlaylists({ limit: 50 })).items
  const tracksOf = async (ref: string) => (await target.getPlaylistTracks(ref, { limit: 50 })).items.map((t) => t.title)
  const runs = () => (existsSync(join(ctx.config.configDir!, 'runs')) ? readdirSync(join(ctx.config.configDir!, 'runs')) : [])
  return { ctx, source, target, out, err, created, tracksOf, runs, reset: () => ((out.length = 0), (err.length = 0)) }
}

const BASE = ['--from', 'spotify', '--to', 'youtube-music']

test('migrate: copies each playlist into a new private playlist with the matched tracks', async () => {
  const t = setup()
  assert.equal(await run(t.ctx, [...BASE, 'Road trip', 'Chill', '--yes']), EXIT_CODES.SUCCESS)

  const playlists = await t.created()
  assert.deepEqual(playlists.map((p) => [p.name, p.public]), [['Road trip', false], ['Chill', false]])
  assert.deepEqual(await t.tracksOf(playlists[0].ref), ['Song 1', 'Song 2'])
  assert.deepEqual(await t.tracksOf(playlists[1].ref), ['Song 3'])
  assert.equal(t.err[0], 'Migrating 2 playlists (3 tracks) from spotify to youtube-music')
  assert.match(t.out[0], /^"Road trip" → "Road trip" \(\d+\): added 2 of 2 matched tracks \(0 low-confidence, 0 unmatched\)$/)
  assert.equal(t.err.at(-1), 'sple: migrated 2 playlists')
  assert.deepEqual(t.runs(), [], 'finished run deleted')
})

test('migrate --dry-run: matches and reports, creates nothing and saves no run', async () => {
  const t = setup()
  assert.equal(await run(t.ctx, [...BASE, 'Road trip', '--dry-run']), EXIT_CODES.SUCCESS)
  assert.deepEqual(await t.created(), [])
  assert.deepEqual(t.runs(), [])
  assert.deepEqual(t.out, ['[dry-run] "Road trip" → "Road trip": would add 2 of 2 tracks (0 low-confidence, 0 unmatched)'])
  assert.equal(t.err[0], '[dry-run] Migrating 1 playlist (2 tracks) from spotify to youtube-music')
})

test('migrate --liked: a private "Liked Songs (from <Source>)" playlist; --name overrides it', async () => {
  const t = setup()
  t.source.getLikedTracks = async () => ({ items: [{ title: 'Song 3', artists: ['A'], durationMs: 1000, refs: { fake: 'fake:track:s3' } }] })
  assert.equal(await run(t.ctx, [...BASE, '--liked', '--yes']), EXIT_CODES.SUCCESS)
  assert.equal(likedPlaylistName(t.source), 'Liked Songs (from Fake Provider)')
  const [liked] = await t.created()
  assert.equal(liked.name, 'Liked Songs (from Fake Provider)')
  assert.deepEqual(await t.tracksOf(liked.ref), ['Song 3'])

  assert.equal(await run(t.ctx, [...BASE, '--liked', '--name', 'Faves', '--yes']), EXIT_CODES.SUCCESS)
  assert.equal((await t.created())[1].name, 'Faves')
})

test('migrate --all: every playlist in the library', async () => {
  const t = setup()
  assert.equal(await run(t.ctx, [...BASE, '--all', '--yes']), EXIT_CODES.SUCCESS)
  assert.deepEqual((await t.created()).map((p) => p.name), ['Road trip', 'Chill'])
})

test('migrate: a quota stop is resumed without recreating finished playlists or duplicating tracks', async () => {
  const t = setup()
  t.target.setQuotaBucket(2) // the fake's quota counts adds: Road trip (2 tracks) fits, then Chill's only track doesn't
  await assert.rejects(run(t.ctx, [...BASE, 'Road trip', 'Chill', '--yes']), QuotaExhaustedError)
  const hint = t.err.join('\n').match(/sple: migrate stopped; resume with: sple migrate --resume (\d{8}-[0-9a-f]{6})/)
  assert.ok(hint, t.err.join(' | '))
  assert.equal((await t.created()).length, 2, 'Chill was created before its add failed')

  t.target.setQuotaBucket(10)
  t.reset()
  assert.equal(await run(t.ctx, ['--resume', hint[1]], { stdinIsTTY: false }), EXIT_CODES.SUCCESS)
  assert.equal(t.err[0], `Resuming migration ${hint[1]}: 2 playlists → youtube-music (1 done)`)
  const playlists = await t.created()
  assert.equal(playlists.length, 2)
  assert.deepEqual(await t.tracksOf(playlists[0].ref), ['Song 1', 'Song 2'])
  assert.deepEqual(await t.tracksOf(playlists[1].ref), ['Song 3'])
  assert.equal(t.out.length, 2, 'both playlists reported, the finished one from the run file')
  assert.deepEqual(t.runs(), [])
})

test('migrate --json and --report <dir>', async () => {
  const t = setup()
  const dir = join(mkdtempSync(join(tmpdir(), 'sple-migrate-reports-')), 'reports')
  assert.equal(await run({ ...t.ctx, json: true }, [...BASE, 'Road trip', 'Chill', '--yes', '--report', dir]), EXIT_CODES.SUCCESS)
  const output = JSON.parse(t.out.at(-1)!) as MigrateOutput
  assert.equal(output.dryRun, false)
  assert.deepEqual([output.from, output.to], ['spotify', 'youtube-music'])
  assert.deepEqual(output.playlists.map((p) => [p.source.name, p.added, p.summary.matched]), [['Road trip', 2, 2], ['Chill', 1, 1]])
  assert.deepEqual(readdirSync(dir), ['01-road-trip.json', '02-chill.json'])
  assert.equal(JSON.parse(readFileSync(join(dir, '01-road-trip.json'), 'utf8')).summary.matched, 2)
})

test('migrate: a source that cannot be found is skipped; the rest are migrated and the exit code says so', async () => {
  const t = setup()
  assert.equal(await run(t.ctx, [...BASE, 'Road trip', 'fake:playlist:99', '--yes']), EXIT_CODES.NOT_FOUND)
  assert.equal((await t.created()).length, 1)
  assert.ok(t.err.some((l) => l.startsWith('sple: skipped "fake:playlist:99"')))
  assert.equal(t.err.at(-1), 'sple: migrated 1 of 2 playlists; 1 skipped (see above)')
})

test('migrate: declining creates nothing', async () => {
  const t = setup()
  const code = await run(t.ctx, [...BASE, 'Road trip'], { stdinIsTTY: true, prompt: async () => false })
  assert.equal(code, EXIT_CODES.ERROR)
  assert.deepEqual(await t.created(), [])
  assert.deepEqual(t.runs(), [])
  assert.equal(t.err.at(-1), 'Aborted; nothing was changed.')
})

test('migrate: usage errors before any request', async () => {
  const t = setup()
  const cases: Array<[string[], RegExp]> = [
    [['Road trip'], /--from and --to are required/],
    [['--from', 'spotify', '--to', 'spotify', 'x'], /must be different providers/],
    [['--from', 'spotify', '--to', 'nope', 'x'], /Unknown provider 'nope'/],
    [BASE, /Nothing to migrate/],
    [[...BASE, 'x', '--all'], /Pass playlists or --all, not both/],
    [[...BASE, 'x', 'y', '--name', 'n'], /--name needs exactly one source/],
    [[...BASE, 'x', '--liked', '--name', 'n'], /--name needs exactly one source/],
    [[...BASE, 'x', '--min-confidence', '2'], /--min-confidence must be a number/],
    [[...BASE, 'x'], /Use --yes/],
    [['--resume', 'last'], /There are no unfinished migrations/],
    [['--resume', 'last', '--from', 'spotify'], /--resume cannot be combined with --from/],
    [['--resume', 'last', 'x'], /--resume takes a run ID, not playlists/],
  ]
  for (const [args, message] of cases) {
    await assert.rejects(run(t.ctx, args, { stdinIsTTY: false }), (e: Error) => e instanceof UsageError && message.test(e.message), args.join(' '))
  }
  assert.deepEqual(await t.created(), [])
})
