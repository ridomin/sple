import { test } from 'node:test'
import * as assert from 'node:assert'
import FakeProvider from '../../src/providers/fake/index.js'
import type { FakePlaylist, FakeTrack } from '../../src/providers/fake/index.js'
import {
  NotFoundError,
  AccessRestrictedError,
  QuotaExhaustedError,
} from '../../src/core/provider/errors.js'

test('FakeProvider', async (t) => {
  let provider: FakeProvider

  await t.before(() => {
    provider = new FakeProvider()
  })

  await t.test('initialization with default config', () => {
    assert.ok(provider.capabilities)
    assert.strictEqual(provider.capabilities.canDeletePlaylist, true)
    assert.strictEqual(provider.capabilities.playlistItemsAccess, 'all')
    assert.strictEqual(provider.capabilities.paginationModel, 'offset')
  })

  await t.test('auth interface', async () => {
    const status = await provider.auth.status()
    assert.strictEqual(status.isLoggedIn, true)
    assert.strictEqual(status.userId, 'fake-user')
  })

  await t.test('creates playlist', async () => {
    const playlist = await provider.createPlaylist({
      name: 'My Playlist',
      description: 'Test playlist',
      public: false,
    })

    assert.ok(playlist.ref)
    assert.strictEqual(playlist.name, 'My Playlist')
    assert.strictEqual(playlist.description, 'Test playlist')
    assert.strictEqual(playlist.owned, true)
    assert.strictEqual(playlist.trackCount, 0)
  })

  await t.test('lists playlists', async () => {
    await provider.createPlaylist({
      name: 'Playlist 1',
      public: false,
    })
    await provider.createPlaylist({
      name: 'Playlist 2',
      public: false,
    })

    const result = await provider.listPlaylists({ limit: 10 })

    assert.ok(result.items.length >= 2)
    assert.strictEqual(result.items[0].name, 'Playlist 1')
  })

  await t.test('gets playlist by ID', async () => {
    const created = await provider.createPlaylist({
      name: 'Test Playlist',
      public: false,
    })
    const retrieved = await provider.getPlaylist(created.ref)

    assert.strictEqual(retrieved.ref, created.ref)
    assert.strictEqual(retrieved.name, 'Test Playlist')
  })

  await t.test('throws NotFoundError for missing playlist', async () => {
    await assert.rejects(
      () => provider.getPlaylist('nonexistent'),
      (error: any) =>
        error instanceof NotFoundError &&
        error.resourceType === 'playlist'
    )
  })

  await t.test('removes playlist', async () => {
    const created = await provider.createPlaylist({
      name: 'To Remove',
      public: false,
    })
    const result = await provider.removePlaylist(created.ref)
    assert.strictEqual(result.action, 'deleted')

    await assert.rejects(
      () => provider.getPlaylist(created.ref),
      NotFoundError
    )
  })

  await t.test('throws error when removing non-owned playlist', async () => {
    const provider2 = new FakeProvider({ userId: 'other-user' })
    const created = await provider.createPlaylist({
      name: 'Other Playlist',
      public: false,
    })

    await assert.rejects(
      () => provider2.removePlaylist(created.ref),
      AccessRestrictedError
    )
  })

  await t.test('respects owned-only access', async () => {
    const provider2 = new FakeProvider({
      userId: 'other-user',
      capabilities: { playlistItemsAccess: 'owned-only' },
    })

    const created = await provider.createPlaylist({
      name: 'Owned by user 1',
      public: false,
    })

    await assert.rejects(
      () => provider2.getPlaylist(created.ref),
      (error: any) =>
        error instanceof AccessRestrictedError &&
        error.reason === 'not-owned'
    )
  })

  await t.test('searches tracks', async () => {
    provider.addTrack({
      id: 'track-1',
      title: 'Bohemian Rhapsody',
      artists: ['Queen'],
      duration: 354,
    })

    provider.addTrack({
      id: 'track-2',
      title: 'Another One Bites the Dust',
      artists: ['Queen'],
      duration: 217,
    })

    const result = await provider.search(
      { text: 'Bohemian', type: 'track' },
      { limit: 50 }
    )

    assert.strictEqual(result.items.length, 1)
    assert.strictEqual((result.items[0] as any).title, 'Bohemian Rhapsody')
  })

  await t.test('searches by artist', async () => {
    provider.addTrack({
      id: 'track-3',
      title: 'Imagine',
      artists: ['John Lennon'],
      duration: 183,
    })

    const result = await provider.search(
      { text: 'John Lennon', type: 'track' },
      { limit: 50 }
    )

    assert.ok(result.items.length > 0)
    assert.strictEqual((result.items[0] as any).artists[0], 'John Lennon')
  })

  await t.test('search respects limit and offset', async () => {
    for (let i = 0; i < 10; i++) {
      provider.addTrack({
        id: `track-offset-${i}`,
        title: `Track ${i}`,
        artists: ['Artist'],
        duration: 200,
      })
    }

    const page1 = await provider.search(
      { text: 'Track', type: 'track' },
      { limit: 3, offset: 0 }
    )
    const page2 = await provider.search(
      { text: 'Track', type: 'track' },
      { limit: 3, offset: 3 }
    )

    assert.strictEqual(page1.items.length, 3)
    assert.strictEqual(page2.items.length, 3)
    assert.notStrictEqual(
      (page1.items[0] as any).title,
      (page2.items[0] as any).title
    )
  })

  await t.test('resolves track by title and artist', async () => {
    provider.addTrack({
      id: 'track-resolve',
      title: 'Shape of You',
      artists: ['Ed Sheeran'],
      duration: 233,
    })

    const matches = await provider.resolveTrack(
      {
        title: 'Shape of You',
        artists: ['Ed Sheeran'],
        refs: {},
      },
      { maxCandidates: 10 }
    )

    assert.ok(matches.length > 0)
    assert.strictEqual(matches[0].ref, 'track-resolve')
    assert.ok(matches[0].confidence > 0.9)
  })

  await t.test('resolves track by ISRC', async () => {
    const provider3 = new FakeProvider({
      capabilities: { isrcSearchMode: 'filter' },
    })

    provider3.addTrack({
      id: 'track-isrc',
      title: 'Song',
      artists: ['Artist'],
      duration: 200,
      isrc: 'USRC17607839',
    })

    const matches = await provider3.resolveTrack(
      {
        title: 'Different Title',
        artists: ['Different Artist'],
        isrc: 'USRC17607839',
        refs: {},
      },
      { maxCandidates: 10 }
    )

    assert.ok(matches.length > 0)
    assert.strictEqual(matches[0].ref, 'track-isrc')
  })

  await t.test('returns empty array for unresolvable track', async () => {
    const matches = await provider.resolveTrack(
      {
        title: 'Nonexistent Song',
        artists: ['Unknown Artist'],
        refs: {},
      },
      { maxCandidates: 10 }
    )

    assert.strictEqual(matches.length, 0)
  })

  await t.test('populates playlist with tracks', async () => {
    const playlist = await provider.createPlaylist({
      name: 'Populated',
      public: false,
    })

    provider.addTrack({
      id: 'pop-track-1',
      title: 'Song 1',
      artists: ['Artist'],
      duration: 200,
    })

    provider.addTrack({
      id: 'pop-track-2',
      title: 'Song 2',
      artists: ['Artist'],
      duration: 200,
    })

    const result = await provider.populatePlaylist(
      playlist.ref,
      ['pop-track-1', 'pop-track-2'],
      { skipExisting: false }
    )

    assert.strictEqual(result.added.length, 2)
    assert.strictEqual(result.failed.length, 0)
  })

  await t.test('handles missing tracks in populate', async () => {
    const playlist = await provider.createPlaylist({
      name: 'Partial',
      public: false,
    })

    provider.addTrack({
      id: 'exist-track',
      title: 'Exists',
      artists: ['Artist'],
      duration: 200,
    })

    const result = await provider.populatePlaylist(
      playlist.ref,
      ['exist-track', 'missing-track'],
      { skipExisting: false }
    )

    assert.strictEqual(result.added.length, 1)
    assert.strictEqual(result.failed.length, 1)
  })

  await t.test('enforces quota limits', async () => {
    const provider4 = new FakeProvider()
    provider4.setQuotaBucket(2)

    const playlist = await provider4.createPlaylist({
      name: 'Quota Test',
      public: false,
    })

    for (let i = 0; i < 5; i++) {
      provider4.addTrack({
        id: `quota-track-${i}`,
        title: `Song ${i}`,
        artists: ['Artist'],
        duration: 200,
      })
    }

    // First two should succeed
    const result1 = await provider4.populatePlaylist(
      playlist.ref,
      ['quota-track-0', 'quota-track-1'],
      { skipExisting: false }
    )
    assert.strictEqual(result1.added.length, 2)

    // Third should fail with QuotaExhaustedError
    await assert.rejects(
      () =>
        provider4.populatePlaylist(
          playlist.ref,
          ['quota-track-2', 'quota-track-3'],
          { skipExisting: false }
        ),
      (error: any) =>
        error instanceof QuotaExhaustedError &&
        error.bucket === 'daily'
    )
  })

  await t.test('configurable capabilities', () => {
    const custom = new FakeProvider({
      capabilities: {
        maxSearchPageSize: 10,
        canDeletePlaylist: false,
        playlistItemsAccess: 'owned-only',
      },
    })

    assert.strictEqual(custom.capabilities.maxSearchPageSize, 10)
    assert.strictEqual(custom.capabilities.canDeletePlaylist, false)
    assert.strictEqual(custom.capabilities.playlistItemsAccess, 'owned-only')
  })

  await t.test('initializes with data', async () => {
    const tracks: FakeTrack[] = [
      {
        id: 't1',
        title: 'Track 1',
        artists: ['Artist 1'],
        duration: 200,
      },
    ]

    const playlists: FakePlaylist[] = [
      {
        id: 'p1',
        name: 'Playlist 1',
        owner: 'fake-user',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ]

    const initialized = new FakeProvider({
      initialTracks: tracks,
      initialPlaylists: playlists,
    })

    assert.ok(initialized.getTrack('t1'))
    const p = await initialized.getPlaylist('p1')
    assert.ok(p)
  })
})
