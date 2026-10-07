import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlaylistCreator } from '../../../src/core/import/playlist-creator.js'
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
      result(1, 'matched', 't1'),
      result(2, 'low-confidence', 't3'),
      result(3, 'unmatched'),
      result(4, 'matched', 't2'),
    ])

    const res = await new PlaylistCreator().createPlaylistFromMatches(provider, report, 'My Playlist')

    assert.deepEqual(await playlistTrackRefs(provider, res.playlistId), ['t1', 't2'])
    assert.equal(res.tracksAdded, 2)
    assert.equal(res.tracksFailed, 0)
    assert.deepEqual(res.failures, [])
  })

  await t.test('reports tracks the provider rejected', async () => {
    const provider = makeProvider()
    const report = makeReport([result(1, 'matched', 't1'), result(2, 'matched', 'missing')])

    const res = await new PlaylistCreator().createPlaylistFromMatches(provider, report, 'My Playlist')

    assert.equal(res.tracksAdded, 1)
    assert.equal(res.tracksFailed, 1)
    assert.deepEqual(res.failures, [{ ref: 'missing', error: 'Track not found' }])
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
    const report = makeReport([result(1, 'matched', 't1'), result(2, 'matched', 't2')])

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
