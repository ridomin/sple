import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlaylistCreator, type AddProgress } from '../../../src/core/import/playlist-creator.js'
import { PlaylistCreationError, PlaylistAddTracksError } from '../../../src/core/import/playlist-errors.js'
import { AuthRequiredError, QuotaExhaustedError } from '../../../src/core/provider/errors.js'
import { FakeProvider } from '../../../src/providers/fake/index.js'
import type { MatchReport, MatchResult } from '../../../src/core/matching/types.js'

function makeProvider(): FakeProvider {
  return new FakeProvider({
    initialTracks: [
      { id: 't1', title: 'Song 1', artists: ['A'], duration: 180000 },
      { id: 't2', title: 'Song 2', artists: ['A'], duration: 180000 },
      { id: 't3', title: 'Song 3', artists: ['A'], duration: 180000 },
    ],
  })
}

function result(position: number, status: MatchResult['status'], trackRef?: string): MatchResult {
  return {
    status,
    position,
    candidate: trackRef
      ? { ref: trackRef, track: { title: `Song ${position}`, artists: [], refs: {} }, confidence: status === 'matched' ? 0.95 : 0.4, strategy: 'metadata' }
      : undefined,
    track: { title: `Song ${position}`, artists: [], durationMs: 180000, refs: {} } as any,
  }
}

function makeReport(results: MatchResult[]): MatchReport {
  return {
    importedAt: new Date().toISOString(),
    sourceFile: { path: '/test.json', provider: 'spotify', playlistName: 'Test', trackCount: results.length },
    targetProvider: 'fake',
    results,
    summary: { total: results.length, matched: 0, lowConfidence: 0, unmatched: 0, unsupported: 0 },
  }
}

async function playlistTrackRefs(provider: FakeProvider, ref: string): Promise<string[]> {
  const page = await provider.getPlaylistTracks(ref, {})
  return page.items.map((t) => t.refs.fake as string)
}

test('PlaylistCreator', async (t) => {
  await t.test('creates a private playlist with the given name', async () => {
    const provider = makeProvider()
    const res = await new PlaylistCreator().createPlaylistFromMatches(provider, makeReport([]), 'My Playlist')

    const playlist = await provider.getPlaylist(res.playlistId)
    assert.equal(playlist.name, 'My Playlist')
    assert.equal(playlist.public, false)
  })

  await t.test('adds only matched tracks, in order, skipping low-confidence and unmatched', async () => {
    const provider = makeProvider()
    const report = makeReport([
      result(1, 'matched', 'fake:track:t1'),
      result(2, 'low-confidence', 'fake:track:t3'),
      result(3, 'unmatched'),
      result(4, 'matched', 'fake:track:t2'),
    ])

    const res = await new PlaylistCreator().createPlaylistFromMatches(provider, report, 'My Playlist')

    assert.deepEqual(await playlistTrackRefs(provider, res.playlistId), ['fake:track:t1', 'fake:track:t2'])
    assert.equal(res.tracksAdded, 2)
    assert.equal(res.tracksFailed, 0)
    assert.deepEqual(res.failures, [])
  })

  await t.test('reports tracks the provider rejected', async () => {
    const provider = makeProvider()
    const report = makeReport([result(1, 'matched', 'fake:track:t1'), result(2, 'matched', 'fake:track:missing')])

    const res = await new PlaylistCreator().createPlaylistFromMatches(provider, report, 'My Playlist')

    assert.equal(res.tracksAdded, 1)
    assert.equal(res.tracksFailed, 1)
    assert.deepEqual(res.failures, [{ ref: 'fake:track:missing', error: 'Track not found' }])
  })

  await t.test('lets provider errors from createPlaylist propagate unchanged', async () => {
    const provider = makeProvider()
    const authError = new AuthRequiredError('missing scope', 'missing-scope', 'playlist-modify')
    provider.createPlaylist = async () => {
      throw authError
    }

    await assert.rejects(
      () => new PlaylistCreator().createPlaylistFromMatches(provider, makeReport([]), 'My Playlist'),
      (err) => err === authError
    )
  })

  await t.test('wraps unexpected createPlaylist errors in PlaylistCreationError', async () => {
    const provider = makeProvider()
    provider.createPlaylist = async () => {
      throw new Error('boom')
    }

    await assert.rejects(
      () => new PlaylistCreator().createPlaylistFromMatches(provider, makeReport([]), 'My Playlist'),
      PlaylistCreationError
    )
  })

  await t.test('identifies the created playlist and keeps the cause when adding tracks fails', async () => {
    const provider = makeProvider()
    provider.setQuotaBucket(1)
    const report = makeReport([result(1, 'matched', 'fake:track:t1'), result(2, 'matched', 'fake:track:t2')])

    const err = await new PlaylistCreator()
      .createPlaylistFromMatches(provider, report, 'My Playlist')
      .then(
        () => assert.fail('expected rejection'),
        (e: unknown) => e
      )

    assert.ok(err instanceof PlaylistAddTracksError)
    assert.ok(err.cause instanceof QuotaExhaustedError)
    const playlist = await provider.getPlaylist(err.playlistId)
    assert.equal(playlist.name, 'My Playlist')
    assert.match(err.message, new RegExp(err.playlistId))
  })
})

// ---- Checkpointed adding (FR-MIG-4, #95) ----

function progress(toAdd: string[]): AddProgress {
  return { toAdd, cursor: 0, added: 0, failed: [] }
}

test('writeMatches adds in batches of maxTracksPerRequest and checkpoints after creating and after each batch', async () => {
  const provider = new FakeProvider({
    capabilities: { maxTracksPerRequest: 2 },
    initialTracks: [1, 2, 3].map((n) => ({ id: `t${n}`, title: `Song ${n}`, artists: ['A'], duration: 1000 })),
  })
  const calls: string[][] = []
  const populate = provider.populatePlaylist.bind(provider)
  provider.populatePlaylist = async (ref, refs, opts) => {
    calls.push(refs)
    return populate(ref, refs, opts)
  }
  const p = progress(['fake:track:t1', 'fake:track:t2', 'fake:track:t3'])
  const snapshots: Array<[boolean, number]> = []
  await new PlaylistCreator().writeMatches(provider, p, 'Mix', { checkpoint: () => snapshots.push([p.playlist !== undefined, p.cursor]) })

  assert.deepEqual(calls, [['fake:track:t1', 'fake:track:t2'], ['fake:track:t3']])
  assert.deepEqual(snapshots, [[true, 0], [true, 2], [true, 3]])
  assert.equal(p.added, 3)
})

test('a stop keeps the progress, and writing again continues without duplicates or a second playlist', async () => {
  const provider = new FakeProvider({
    capabilities: { maxTracksPerRequest: 1 },
    initialTracks: [1, 2, 3].map((n) => ({ id: `t${n}`, title: `Song ${n}`, artists: ['A'], duration: 1000 })),
  })
  provider.setQuotaBucket(2)
  const p = progress(['fake:track:t1', 'fake:track:t2', 'fake:track:t3'])
  const err = await new PlaylistCreator().writeMatches(provider, p, 'Mix').catch((e: unknown) => e)
  assert.ok(err instanceof PlaylistAddTracksError)
  assert.ok(err.cause instanceof QuotaExhaustedError)
  assert.equal(p.cursor, 2)
  assert.equal(p.added, 2)

  provider.setQuotaBucket(10)
  const created = p.playlist!
  const res = await new PlaylistCreator().writeMatches(provider, p, 'Mix', { reconcile: true })
  assert.equal(res.playlist.ref, created.ref, 'same playlist')
  assert.deepEqual(await playlistTrackRefs(provider, created.ref), ['fake:track:t1', 'fake:track:t2', 'fake:track:t3'])
  assert.equal(res.tracksAdded, 3)
  assert.equal((await provider.listPlaylists({ limit: 50 })).items.length, 1)
})

test('reconcile skips tracks added after the last checkpoint (crash between the add and the save)', async () => {
  const provider = new FakeProvider({
    capabilities: { maxTracksPerRequest: 1 },
    initialTracks: [1, 2].map((n) => ({ id: `t${n}`, title: `Song ${n}`, artists: ['A'], duration: 1000 })),
  })
  const p = progress(['fake:track:t1', 'fake:track:t2'])
  // The first add reached the provider, but the process died before the checkpoint.
  let crashed = false
  await new PlaylistCreator()
    .writeMatches(provider, p, 'Mix', {
      checkpoint: () => {
        if (p.cursor === 1 && !crashed) {
          crashed = true
          p.cursor = 0
          p.added = 0
          throw new Error('crash')
        }
      },
    })
    .catch(() => undefined)
  assert.equal(p.cursor, 0)

  const res = await new PlaylistCreator().writeMatches(provider, p, 'Mix', { reconcile: true })
  assert.deepEqual(await playlistTrackRefs(provider, res.playlist.ref), ['fake:track:t1', 'fake:track:t2'], 't1 not added twice')
  assert.equal(res.tracksAdded, 2)
})

test('reconcile accounts for tracks the provider rejected', async () => {
  const provider = new FakeProvider({
    capabilities: { maxTracksPerRequest: 1 },
    initialTracks: [{ id: 't1', title: 'Song 1', artists: ['A'], duration: 1000 }, { id: 't2', title: 'Song 2', artists: ['A'], duration: 1000 }],
  })
  provider.setQuotaBucket(1)
  const p = progress(['fake:track:missing', 'fake:track:t1', 'fake:track:t2'])
  await new PlaylistCreator().writeMatches(provider, p, 'Mix').catch(() => undefined)
  assert.deepEqual([p.cursor, p.added, p.failed.length], [2, 1, 1])

  provider.setQuotaBucket(10)
  const res = await new PlaylistCreator().writeMatches(provider, p, 'Mix', { reconcile: true })
  assert.deepEqual(await playlistTrackRefs(provider, res.playlist.ref), ['fake:track:t1', 'fake:track:t2'])
  assert.deepEqual([res.tracksAdded, res.tracksFailed], [2, 1])
})
