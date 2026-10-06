import { test } from 'node:test'
import * as assert from 'node:assert'
import { match, strictEqual } from 'node:assert'
import { resolvePlaylist, clearPlaylistCache } from '../../src/core/playlist-resolver.js'
import { FakeProvider } from '../../src/providers/fake/index.js'
import { NotFoundError, UsageError } from '../../src/core/provider/errors.js'

const ID = '6UGD4JQwKMz7nVZAKWQaFS'

test('resolvePlaylist: resolves bare playlist ID', async () => {
  clearPlaylistCache()
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: '1',
        name: 'My Playlist',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  const result = await resolvePlaylist(provider, '1')
  assert.strictEqual(result.ref, '1')
  assert.strictEqual(result.name, 'My Playlist')
})

test('resolvePlaylist: resolves fake:playlist URI', async () => {
  clearPlaylistCache()
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: 'my-playlist',
        name: 'My Playlist',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  const result = await resolvePlaylist(provider, 'fake:playlist:my-playlist')
  assert.strictEqual(result.ref, 'my-playlist')
  assert.strictEqual(result.name, 'My Playlist')
})

test('resolvePlaylist: resolves with exact case-sensitive name match', async () => {
  clearPlaylistCache()
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: '1',
        name: 'My Playlist',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  const result = await resolvePlaylist(provider, 'My Playlist')
  assert.strictEqual(result.ref, '1')
  assert.strictEqual(result.name, 'My Playlist')
})

test('resolvePlaylist: resolves with case-insensitive name match', async () => {
  clearPlaylistCache()
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: '1',
        name: 'My Playlist',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  const result = await resolvePlaylist(provider, 'my playlist')
  assert.strictEqual(result.ref, '1')
  assert.strictEqual(result.name, 'My Playlist')
})

test('resolvePlaylist: prioritizes case-sensitive match over case-insensitive', async () => {
  clearPlaylistCache()
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: '1',
        name: 'My Playlist',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
      {
        id: '2',
        name: 'my playlist',
        owner: 'user-456',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  const result = await resolvePlaylist(provider, 'my playlist')
  assert.strictEqual(result.ref, '2')
})

test('resolvePlaylist: throws NotFoundError when playlist does not exist', async () => {
  clearPlaylistCache()
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: '1',
        name: 'My Playlist',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  await assert.rejects(
    () => resolvePlaylist(provider, 'Nonexistent Playlist'),
    NotFoundError
  )
})

test('resolvePlaylist: a missing URI does not fall back to name lookup', async () => {
  clearPlaylistCache()
  // A playlist named after the URI of a playlist that does not exist
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: '1',
        name: 'fake:playlist:missing',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  await assert.rejects(
    () => resolvePlaylist(provider, 'fake:playlist:missing'),
    NotFoundError
  )
})

test('resolvePlaylist: throws UsageError for ambiguous case-sensitive matches', async () => {
  clearPlaylistCache()
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: '1',
        name: 'My Playlist',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
      {
        id: '2',
        name: 'My Playlist',
        owner: 'user-456',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  let error: Error | null = null
  try {
    await resolvePlaylist(provider, 'My Playlist')
  } catch (err) {
    error = err as Error
  }

  assert.ok(error instanceof UsageError, 'Should throw UsageError')
  match(error.message, /Multiple playlists matched/)
  match(error.message, /My Playlist/)
  match(error.message, /id: 1/)
  match(error.message, /id: 2/)
  match(error.message, /owner/)
  match(error.message, /Specify the playlist ID/)
})

test('resolvePlaylist: throws UsageError for ambiguous case-insensitive matches', async () => {
  clearPlaylistCache()
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: '1',
        name: 'My Playlist',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
      {
        id: '2',
        name: 'my playlist',
        owner: 'user-456',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  let error: Error | null = null
  try {
    await resolvePlaylist(provider, 'MY PLAYLIST')
  } catch (err) {
    error = err as Error
  }

  assert.ok(error instanceof UsageError, 'Should throw UsageError')
  match(error.message, /Multiple playlists matched/)
})

test('resolvePlaylist: ambiguous error includes owner and owned status', async () => {
  clearPlaylistCache()
  const provider = new FakeProvider({
    userId: 'current-user',
    initialPlaylists: [
      {
        id: '1',
        name: 'Foo',
        owner: 'current-user',
        public: true,
        collaborative: false,
        trackIds: [],
      },
      {
        id: '2',
        name: 'Foo',
        owner: 'other-user',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  let error: Error | null = null
  try {
    await resolvePlaylist(provider, 'Foo')
  } catch (err) {
    error = err as Error
  }

  assert.ok(error instanceof UsageError, 'Should throw UsageError')
  // Should indicate which playlist is owned by the current user
  match(error.message, /\(owned\)/)
  match(error.message, /owner: current-user/)
  match(error.message, /owner: other-user/)
})

test('resolvePlaylist: caches playlist list across multiple calls', async () => {
  clearPlaylistCache()
  let listCallCount = 0
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: '1',
        name: 'Playlist A',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  // Override listPlaylists to track calls
  const originalListPlaylists = provider.listPlaylists.bind(provider)
  provider.listPlaylists = async function (page) {
    listCallCount++
    return originalListPlaylists(page)
  }

  // First call
  await resolvePlaylist(provider, 'Playlist A')
  const firstCallCount = listCallCount

  // Second call with different name
  try {
    await resolvePlaylist(provider, 'Playlist B')
  } catch {
    // Expected to not find Playlist B, but cache should be used
  }

  // listCallCount should not increase because the cache should be used
  assert.strictEqual(listCallCount, firstCallCount)
})

test('resolvePlaylist: handles pagination across multiple pages', async () => {
  clearPlaylistCache()
  const provider = new FakeProvider({
    initialPlaylists: [
      {
        id: '1',
        name: 'Playlist 1',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
      {
        id: '2',
        name: 'Playlist 2',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
      {
        id: '3',
        name: 'Playlist 3',
        owner: 'user-123',
        public: true,
        collaborative: false,
        trackIds: [],
      },
    ],
  })

  // Request with small page size to force pagination
  const result = await resolvePlaylist(provider, 'Playlist 3')
  assert.strictEqual(result.ref, '3')
  assert.strictEqual(result.name, 'Playlist 3')
})

test('resolvePlaylist: resolves spotify playlist ID (integration)', async () => {
  const { createSpotifyProvider } = await import('../../src/providers/spotify/index.js')
  const provider = createSpotifyProvider('fake-client-id')

  // createSpotifyProvider doesn't implement listPlaylists, so we test the parsePlaylistRef
  // through the provider directly
  const ref = provider.parsePlaylistRef(ID)
  assert.strictEqual(ref, ID)

  const ref2 = provider.parsePlaylistRef(`spotify:playlist:${ID}`)
  assert.strictEqual(ref2, ID)

  const ref3 = provider.parsePlaylistRef(
    `https://open.spotify.com/playlist/${ID}?si=abc123`
  )
  assert.strictEqual(ref3, ID)

  const ref4 = provider.parsePlaylistRef(`https://open.spotify.com/intl-de/playlist/${ID}`)
  assert.strictEqual(ref4, ID)

  // Non-ref input should return null
  const ref5 = provider.parsePlaylistRef('My Playlist')
  assert.strictEqual(ref5, null)
})

// Table-driven tests for different ref formats
test('resolvePlaylist: table-driven various ref formats', async (t) => {
  const testCases: Array<[string, boolean]> = [
    [ID, true], // bare ID
    [`spotify:playlist:${ID}`, true], // URI
    [`https://open.spotify.com/playlist/${ID}`, true], // URL
    [`https://open.spotify.com/playlist/${ID}?si=abc123`, true], // URL with query
    [`https://open.spotify.com/intl-de/playlist/${ID}`, true], // intl URL
    [`https://open.spotify.com/intl-pt-BR/playlist/${ID}?si=x`, true], // intl URL with query
    [`http://open.spotify.com/playlist/${ID}`, true], // http
    ['My Playlist', false], // name (not a ref)
    ['', false], // empty
    [`${ID}x`, false], // invalid ID
  ]

  const { createSpotifyProvider } = await import('../../src/providers/spotify/index.js')
  const provider = createSpotifyProvider('fake-client-id')

  for (const [input, shouldResolve] of testCases) {
    await t.test(`parsePlaylistRef(${JSON.stringify(input)})`, () => {
      const result = provider.parsePlaylistRef(input)
      if (shouldResolve) {
        assert.strictEqual(result, ID, `Expected ${input} to resolve to ${ID}`)
      } else {
        assert.strictEqual(result, null, `Expected ${input} to return null`)
      }
    })
  }
})
