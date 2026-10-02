import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'
import {
  SPOTIFY_LOGIN_SCOPES,
  SPOTIFY_OPERATION_SCOPES,
  assertScopes,
  requiredScopes,
} from '../../../src/providers/spotify/scopes.js'
import { saveTokens } from '../../../src/core/config/token-store.js'
import { AuthRequiredError } from '../../../src/core/provider/errors.js'
import { EXIT_CODES, formatErrorMessage, getExitCode } from '../../../src/cli/exit-codes.js'
import type { Provider } from '../../../src/core/provider/provider.js'

let dir: string
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sple-spotify-scopes-'))
  // The scope check must run before any request.
  // When scope check passes, implemented methods try to call the network (which fails here).
  // When scope check fails, no network call is attempted.
  globalThis.fetch = (async () => {
    throw new Error('Network mock: scope check passed (no network expected in test)')
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
})

function login(scopes: string[]) {
  saveTokens(
    'spotify',
    {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes,
      userId: 'u',
      grantedAt: new Date().toISOString(),
    },
    dir
  )
}

const page = { limit: 10 }
/** Read operations take a resolved playlist ID (names are resolved before the provider call). */
const PLAYLIST_ID = '0FRr10mglUR3E0Pq8TqlxL'

/** Each M1 command's provider call, with the scopes it needs. */
const OPERATIONS: Array<{ name: string; call: (p: Provider) => Promise<unknown>; scopes: string[] }> = [
  { name: 'search', call: (p) => p.search({ text: 'x', type: 'track' }, page), scopes: [] },
  {
    name: 'playlist list (listPlaylists)',
    call: (p) => p.listPlaylists(page),
    scopes: ['playlist-read-private', 'playlist-read-collaborative'],
  },
  { name: 'playlist show (getPlaylist)', call: (p) => p.getPlaylist(PLAYLIST_ID), scopes: ['playlist-read-private'] },
  {
    name: 'playlist show / export (getPlaylistTracks)',
    call: (p) => p.getPlaylistTracks(PLAYLIST_ID, page),
    scopes: ['playlist-read-private'],
  },
  { name: 'export --liked (getLikedTracks)', call: (p) => p.getLikedTracks(page), scopes: ['user-library-read'] },
  {
    name: 'playlist create --public',
    call: (p) => p.createPlaylist({ name: 'n', public: true }),
    scopes: ['playlist-modify-public'],
  },
  {
    name: 'playlist create (private)',
    call: (p) => p.createPlaylist({ name: 'n', public: false }),
    scopes: ['playlist-modify-private'],
  },
  {
    name: 'playlist create --collaborative',
    call: (p) => p.createPlaylist({ name: 'n', public: false, collaborative: true }),
    scopes: ['playlist-modify-public', 'playlist-modify-private'],
  },
  {
    name: 'playlist remove',
    call: (p) => p.removePlaylist('x'),
    scopes: ['playlist-modify-public', 'playlist-modify-private'],
  },
]

test('scope table covers exactly the M1 operations', () => {
  assert.deepEqual(Object.keys(SPOTIFY_OPERATION_SCOPES).sort(), [
    'createPlaylist',
    'getPlaylistItems',
    'listPlaylists',
    'readLiked',
    'removePlaylist',
    'search',
  ])
  assert.deepEqual(SPOTIFY_OPERATION_SCOPES.search, [])
  assert.deepEqual(SPOTIFY_OPERATION_SCOPES.readLiked, ['user-library-read'])
})

test('login scopes are the de-duplicated union of the table', () => {
  const union = new Set(Object.values(SPOTIFY_OPERATION_SCOPES).flat())
  assert.deepEqual([...SPOTIFY_LOGIN_SCOPES].sort(), [...union].sort())
  assert.equal(new Set(SPOTIFY_LOGIN_SCOPES).size, SPOTIFY_LOGIN_SCOPES.length)
})

test('requiredScopes narrows createPlaylist by visibility', () => {
  assert.deepEqual(requiredScopes('createPlaylist', { public: true }), ['playlist-modify-public'])
  assert.deepEqual(requiredScopes('createPlaylist', { public: false }), ['playlist-modify-private'])
  assert.deepEqual(requiredScopes('createPlaylist', { public: false, collaborative: true }), [
    'playlist-modify-public',
    'playlist-modify-private',
  ])
  assert.deepEqual(requiredScopes('createPlaylist'), ['playlist-modify-public', 'playlist-modify-private'])
})

test('assertScopes throws missing-scope naming the first missing scope', () => {
  assert.doesNotThrow(() => assertScopes(['a', 'b'], ['b']))
  assert.throws(
    () => assertScopes(['a'], ['a', 'b', 'c']),
    (e: unknown) =>
      e instanceof AuthRequiredError &&
      e.reason === 'missing-scope' &&
      e.scope === 'b' &&
      e.message === 'Run "sple auth login" to grant b'
  )
})

for (const op of OPERATIONS) {
  for (const missing of op.scopes) {
    test(`${op.name}: without ${missing} → exit 3 naming the scope, no request`, async () => {
      login(SPOTIFY_LOGIN_SCOPES.filter((s) => s !== missing))
      const provider = createSpotifyProvider('cid', dir)
      await assert.rejects(op.call(provider), (e: unknown) => {
        assert.ok(e instanceof AuthRequiredError)
        assert.equal(e.reason, 'missing-scope')
        assert.equal(e.scope, missing)
        assert.equal(e.message, `Run "sple auth login" to grant ${missing}`)
        assert.equal(getExitCode(e), EXIT_CODES.AUTH_REQUIRED)
        assert.ok(formatErrorMessage(e).includes(`Run "sple auth login" to grant ${missing}`))
        return true
      })
    })
  }

  test(`${op.name}: not logged in → exit 3 (no-token)`, async () => {
    await assert.rejects(op.call(createSpotifyProvider('cid', dir)), (e: unknown) => {
      assert.ok(e instanceof AuthRequiredError)
      assert.equal(e.reason, 'no-token')
      assert.equal(getExitCode(e), EXIT_CODES.AUTH_REQUIRED)
      return true
    })
  })

  test(`${op.name}: only its own scopes → passes the scope check`, async () => {
    login(op.scopes)
    // Operations are implemented in M1-19..M1-21; reaching the network call means the scope check passed.
    // The network mock throws, but that's expected - scope check passed and tried to reach API.
    await assert.rejects(op.call(createSpotifyProvider('cid', dir)), /Could not reach the Spotify API|Network mock/)
  })
}
