import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'
import { saveTokens } from '../../../src/core/config/token-store.js'
import { AuthRequiredError } from '../../../src/core/provider/errors.js'

// ADR-0003 Amendment 2: the adapter turns a TrackQuery into Spotify search syntax.

const FIXTURES = new URL('../../fixtures/spotify/', import.meta.url)
const realFetch = globalThis.fetch

test('Spotify searchTracks', async (t) => {
  let dir = ''
  let requests: URL[] = []

  t.beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/sple-search-tracks-`)
    requests = []
    const fx = JSON.parse(readFileSync(new URL('search-isrc-hello.json', FIXTURES), 'utf8'))
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(new URL(String(input)))
      return Response.json(fx.body)
    }) as typeof fetch
  })

  t.afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const login = () =>
    saveTokens(
      'spotify',
      {
        accessToken: 'at',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: [],
        userId: 'u',
        grantedAt: new Date().toISOString(),
      },
      dir
    )

  await t.test('an ISRC query searches q=isrc:<code> for tracks', async () => {
    login()
    const hits = await createSpotifyProvider('cid', dir).searchTracks({ kind: 'isrc', isrc: 'GBBKS1500214' }, { limit: 5 })

    assert.equal(requests.length, 1)
    assert.equal(requests[0].pathname, '/v1/search')
    assert.equal(requests[0].searchParams.get('q'), 'isrc:GBBKS1500214')
    assert.equal(requests[0].searchParams.get('type'), 'track')
    assert.equal(requests[0].searchParams.get('limit'), '5')
    assert.equal(hits.length, 2)
    assert.match(hits[0].ref, /^spotify:track:[A-Za-z0-9]{22}$/)
    assert.equal(hits[0].track.refs.spotify, hits[0].ref)
    assert.equal(hits[0].track.title, 'Hello')
  })

  await t.test('a metadata query searches "<title> <first artist>"', async () => {
    login()
    await createSpotifyProvider('cid', dir).searchTracks(
      { kind: 'metadata', title: 'Hello', artists: ['Adele', 'Someone'], album: '25', durationMs: 295000 },
      { limit: 10 }
    )

    assert.equal(requests[0].searchParams.get('q'), 'Hello Adele')
    assert.equal(requests[0].searchParams.get('limit'), '10')
  })

  await t.test('returns at most limit hits', async () => {
    login()
    const hits = await createSpotifyProvider('cid', dir).searchTracks({ kind: 'isrc', isrc: 'GBBKS1500214' }, { limit: 1 })
    assert.equal(hits.length, 1)
  })

  await t.test('requires a login', async () => {
    await assert.rejects(
      () => createSpotifyProvider('cid', dir).searchTracks({ kind: 'isrc', isrc: 'X' }, { limit: 5 }),
      AuthRequiredError
    )
  })
})
