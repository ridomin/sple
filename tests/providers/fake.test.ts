import { test } from 'node:test'
import * as assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import FakeProvider from '../../src/providers/fake/index.js'
import type { FakePlaylist, FakeTrack } from '../../src/providers/fake/index.js'
import {
  NotFoundError,
  AccessRestrictedError,
  QuotaExhaustedError,
} from '../../src/core/provider/errors.js'

test('FakeProvider', async (t) => {
  let provider: FakeProvider

  let tempDir: string

  await t.before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sple-fake-'))
    provider = new FakeProvider({ configDir: tempDir })
  })

  await t.after(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  await t.test('initialization with default config', () => {
    assert.ok(provider.capabilities)
    assert.strictEqual(provider.capabilities.canDeletePlaylist, true)
    assert.strictEqual(provider.capabilities.playlistItemsAccess, 'all')
    assert.strictEqual(provider.capabilities.paginationModel, 'offset')
  })

  await t.test('auth interface', async () => {
    // Before login, status should show not logged in
    let status = await provider.auth.status()
    assert.strictEqual(status.loggedIn, false)

    // After login, status should show logged in
    const loginStatus = await provider.auth.login({ mode: 'no-browser', scopes: [] })
    assert.strictEqual(loginStatus.loggedIn, true)
    assert.strictEqual(loginStatus.user?.id, 'fake-user')

    status = await provider.auth.status()
    assert.strictEqual(status.loggedIn, true)
    assert.strictEqual(status.user?.id, 'fake-user')
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
    const p = new FakeProvider()
    await p.createPlaylist({
      name: 'Playlist 1',
      public: false,
    })
    await p.createPlaylist({
      name: 'Playlist 2',
      public: false,
    })

    const result = await p.listPlaylists({ limit: 10 })

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
    const p = new FakeProvider({ userId: 'user2' })

    // Create a playlist owned by a different user
    const fakePlaylist: FakePlaylist = {
      id: 'owned-by-user1',
      name: 'Owned by user1',
      owner: 'user1',
      public: false,
      collaborative: false,
      trackIds: [],
    }
    // Access private property for testing only
    ;(p as any).playlists.set('owned-by-user1', fakePlaylist)

    // user2 should not be able to remove user1's playlist
    await assert.rejects(
      () => p.removePlaylist('owned-by-user1'),
      AccessRestrictedError
    )
  })

  await t.test('respects owned-only access', async () => {
    const p = new FakeProvider({
      userId: 'user1',
      capabilities: { playlistItemsAccess: 'owned-only' },
    })

    // Create a playlist owned by user1
    const playlist1 = await p.createPlaylist({
      name: 'Owned by user1',
      public: false,
    })

    // Should be able to get it (user1 is the owner)
    const retrieved = await p.getPlaylist(playlist1.ref)
    assert.ok(retrieved)

    // Simulate access from a different user by manually adding a non-owned playlist
    // This verifies the ownership check works
    const fakePlaylist: FakePlaylist = {
      id: 'fake-pl',
      name: 'Not owned by user1',
      owner: 'user2',
      public: false,
      collaborative: false,
      trackIds: [],
    }
    // Access private property for testing only
    ;(p as any).playlists.set('fake-pl', fakePlaylist)

    // Metadata is visible, but items are not (ADR-0003 §3)
    const summary = await p.getPlaylist('fake-pl')
    assert.strictEqual(summary.owned, false)
    assert.strictEqual(summary.itemsReadable, false)
    assert.strictEqual(retrieved.itemsReadable, true)

    await assert.rejects(
      () => p.getPlaylistTracks('fake-pl', { limit: 10 }),
      (error: any) =>
        error instanceof AccessRestrictedError &&
        error.reason === 'not-owned'
    )
  })

  await t.test('respects owned-or-collaborator access', async () => {
    const p = new FakeProvider({
      userId: 'user1',
      capabilities: { playlistItemsAccess: 'owned-or-collaborator' },
      initialTracks: [{ id: 't1', title: 'Song', artists: ['A'], duration: 1 }],
      initialPlaylists: [
        { id: 'collab', name: 'Collab', owner: 'user2', public: false, collaborative: true, trackIds: ['t1'] },
        { id: 'followed', name: 'Followed', owner: 'user2', public: true, collaborative: false, trackIds: ['t1'] },
      ],
    })

    assert.strictEqual((await p.getPlaylist('collab')).itemsReadable, true)
    const items = await p.getPlaylistTracks('collab', { limit: 10 })
    assert.strictEqual(items.items.length, 1)

    assert.strictEqual((await p.getPlaylist('followed')).itemsReadable, false)
    await assert.rejects(
      () => p.getPlaylistTracks('followed', { limit: 10 }),
      AccessRestrictedError
    )

    const listed = await p.listPlaylists({ limit: 10 })
    const readable = Object.fromEntries(listed.items.map((i) => [i.ref, i.itemsReadable]))
    assert.deepStrictEqual(readable, { collab: true, followed: false })
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
    const item = result.items[0]
    assert.ok(item.type === 'track')
    assert.strictEqual(item.name, 'Bohemian Rhapsody')
    assert.strictEqual(item.id, 'track-1')
    assert.strictEqual(item.ref, 'fake:track:track-1')
    assert.strictEqual(item.track.title, 'Bohemian Rhapsody')
    assert.deepStrictEqual(item.track.refs, { fake: 'fake:track:track-1' })
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
    const item = result.items[0]
    assert.ok(item.type === 'track')
    assert.strictEqual(item.track.artists[0], 'John Lennon')
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
    assert.ok(page1.items[0].name)
    assert.notStrictEqual(page1.items[0].name, page2.items[0].name)
    assert.deepStrictEqual(page1.next, { offset: 3 })
  })

  await t.test('search returns typed album, artist, and playlist items', async () => {
    const p = new FakeProvider({
      initialTracks: [
        { id: 'a1', title: 'Come Together', artists: ['The Beatles'], album: 'Abbey Road', duration: 259 },
        { id: 'a2', title: 'Something', artists: ['The Beatles'], album: 'Abbey Road', duration: 182 },
        { id: 'a3', title: 'Help!', artists: ['The Beatles'], album: 'Help!', duration: 139 },
      ],
      initialPlaylists: [
        { id: '7', name: 'Beatles Mix', owner: 'someone', public: true, collaborative: false, trackIds: ['a1', 'a3'] },
      ],
    })

    const albums = await p.search({ text: 'abbey', type: 'album' }, { limit: 10 })
    assert.strictEqual(albums.items.length, 1)
    const album = albums.items[0]
    assert.ok(album.type === 'album')
    assert.strictEqual(album.name, 'Abbey Road')
    assert.deepStrictEqual(album.artists, ['The Beatles'])
    assert.strictEqual(album.trackCount, 2)
    assert.ok(album.id && album.ref)

    const artists = await p.search({ text: 'beatles', type: 'artist' }, { limit: 10 })
    assert.strictEqual(artists.items.length, 1)
    const artist = artists.items[0]
    assert.strictEqual(artist.type, 'artist')
    assert.strictEqual(artist.name, 'The Beatles')

    const playlists = await p.search({ text: 'mix', type: 'playlist' }, { limit: 10 })
    assert.strictEqual(playlists.items.length, 1)
    const pl = playlists.items[0]
    assert.ok(pl.type === 'playlist')
    assert.strictEqual(pl.ref, '7')
    assert.strictEqual(pl.name, 'Beatles Mix')
    assert.strictEqual(pl.owner.id, 'someone')
    assert.strictEqual(pl.trackCount, 2)
  })

  await t.test('parsePlaylistRef', () => {
    const p = new FakeProvider()
    const cases: Array<[string, string | null]> = [
      ['42', '42'],
      ['  42  ', '42'],
      ['fake:playlist:42', '42'],
      ['fake:playlist:owned-by-user1', 'owned-by-user1'],
      ['My Playlist', null],
      ['fake-pl', null],
      ['', null],
      ['fake:playlist:', null],
      ['spotify:playlist:6UGD4JQwKMz7nVZAKWQaFS', null],
    ]
    for (const [input, expected] of cases) {
      assert.strictEqual(p.parsePlaylistRef(input), expected, `input: ${JSON.stringify(input)}`)
    }
  })

  await t.test('stores and reports displayName from the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sple-fake-dn-'))
    try {
      const p = new FakeProvider({ configDir: dir })
      await p.auth.login({ mode: 'no-browser', scopes: [] })
      const status = await p.auth.status()
      assert.strictEqual(status.user?.displayName, 'Fake User')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await t.test('parseTrackRef accepts only fake:track:<id>', () => {
    assert.strictEqual(provider.parseTrackRef('fake:track:t1'), 'fake:track:t1')
    assert.strictEqual(provider.parseTrackRef(' fake:track:a_b-1 '), 'fake:track:a_b-1')
    assert.strictEqual(provider.parseTrackRef('t1'), null)
    assert.strictEqual(provider.parseTrackRef('fake:playlist:1'), null)
    assert.strictEqual(provider.parseTrackRef('spotify:track:4uLU6hMCjMI75M1A2tKUQC'), null)
  })

  await t.test('searchTracks by metadata returns hits whose title matches', async () => {
    provider.addTrack({
      id: 'track-resolve',
      title: 'Shape of You',
      artists: ['Ed Sheeran'],
      duration: 233,
    })

    const hits = await provider.searchTracks(
      { kind: 'metadata', title: 'shape of you', artists: ['Someone Else'] },
      { limit: 10 }
    )

    assert.deepStrictEqual(hits.map((h) => h.ref), ['fake:track:track-resolve'])
    assert.strictEqual(hits[0].track.refs.fake, 'fake:track:track-resolve')
    assert.strictEqual(hits[0].track.title, 'Shape of You')
    assert.deepStrictEqual(hits[0].track.artists, ['Ed Sheeran'])
  })

  await t.test('searchTracks by ISRC returns hits with that ISRC', async () => {
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
    provider3.addTrack({ id: 'other', title: 'Song', artists: ['Artist'], duration: 200, isrc: 'USRC00000000' })

    const hits = await provider3.searchTracks({ kind: 'isrc', isrc: 'USRC17607839' }, { limit: 10 })

    assert.deepStrictEqual(hits.map((h) => h.ref), ['fake:track:track-isrc'])
  })

  await t.test('searchTracks honours limit', async () => {
    const p = new FakeProvider()
    for (let i = 0; i < 5; i++) p.addTrack({ id: `t${i}`, title: 'Same Title', artists: ['A'], duration: 200 })
    const hits = await p.searchTracks({ kind: 'metadata', title: 'Same Title', artists: [] }, { limit: 3 })
    assert.deepStrictEqual(hits.map((h) => h.ref), ['fake:track:t0', 'fake:track:t1', 'fake:track:t2'])
  })

  await t.test('searchTracks returns no hits for an unknown track', async () => {
    const hits = await provider.searchTracks(
      { kind: 'metadata', title: 'Nonexistent Song', artists: ['Unknown Artist'] },
      { limit: 10 }
    )

    assert.strictEqual(hits.length, 0)
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
      ['fake:track:pop-track-1', 'fake:track:pop-track-2'],
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
      ['fake:track:exist-track', 'fake:track:missing-track'],
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
      ['fake:track:quota-track-0', 'fake:track:quota-track-1'],
      { skipExisting: false }
    )
    assert.strictEqual(result1.added.length, 2)

    // Third should fail with QuotaExhaustedError
    await assert.rejects(
      () =>
        provider4.populatePlaylist(
          playlist.ref,
          ['fake:track:quota-track-2', 'fake:track:quota-track-3'],
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
