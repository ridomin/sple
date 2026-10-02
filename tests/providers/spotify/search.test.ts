import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mapSpotifySearchResults } from '../../../src/providers/spotify/mappers.js'

test('mapSpotifySearchResults: maps track search results correctly', () => {
  const mockSearchResponse = {
    tracks: {
      items: [
        {
          id: 'track1',
          name: 'Song 1',
          uri: 'spotify:track:track1',
          type: 'track',
          artists: [{ name: 'Artist 1' }],
          duration_ms: 180000,
        },
        {
          id: 'track2',
          name: 'Song 2',
          uri: 'spotify:track:track2',
          type: 'track',
          artists: [{ name: 'Artist 2' }],
          duration_ms: 200000,
        },
      ],
    },
  }

  const result = mapSpotifySearchResults(mockSearchResponse)

  assert.strictEqual(result.length, 2)
  assert.strictEqual(result[0].name, 'Song 1')
  assert.strictEqual(result[0].type, 'track')
  assert.strictEqual(result[0].id, 'track1')
  assert.strictEqual(result[0].ref, 'spotify:track:track1')
  assert.ok(result[0].url?.includes('open.spotify.com/track/track1'))
})

test('mapSpotifySearchResults: maps mixed track, album, artist, and playlist results', () => {
  const mockSearchResponse = {
    tracks: {
      items: [
        {
          id: 'track1',
          name: 'Song 1',
          uri: 'spotify:track:track1',
          type: 'track',
          artists: [{ name: 'Artist 1' }],
          duration_ms: 180000,
        },
      ],
    },
    albums: {
      items: [
        {
          id: 'album1',
          name: 'Album 1',
          uri: 'spotify:album:album1',
          type: 'album',
          artists: [{ name: 'Artist 1' }],
          release_date: '2020-01-01',
          total_tracks: 10,
        },
      ],
    },
    artists: {
      items: [
        {
          id: 'artist1',
          name: 'Artist 1',
          uri: 'spotify:artist:artist1',
          type: 'artist',
        },
      ],
    },
    playlists: {
      items: [
        {
          id: 'playlist1',
          name: 'Playlist 1',
          uri: 'spotify:playlist:playlist1',
          type: 'playlist',
          owner: { id: 'user123', display_name: 'Owner' },
          tracks: { total: 50 },
        },
      ],
    },
  }

  const result = mapSpotifySearchResults(mockSearchResponse)

  assert.strictEqual(result.length, 4)

  const track = result.find((i) => i.type === 'track')
  assert.ok(track)
  assert.strictEqual(track?.name, 'Song 1')

  const album = result.find((i) => i.type === 'album')
  assert.ok(album)
  assert.strictEqual(album?.name, 'Album 1')
  assert.strictEqual(album?.releaseDate, '2020-01-01')

  const artist = result.find((i) => i.type === 'artist')
  assert.ok(artist)
  assert.strictEqual(artist?.name, 'Artist 1')

  const playlist = result.find((i) => i.type === 'playlist')
  assert.ok(playlist)
  assert.strictEqual(playlist?.name, 'Playlist 1')
  assert.strictEqual(playlist?.trackCount, 50)
})

test('mapSpotifySearchResults: handles empty results', () => {
  const mockSearchResponse = {
    tracks: {
      items: [],
    },
  }

  const result = mapSpotifySearchResults(mockSearchResponse)

  assert.strictEqual(result.length, 0)
})

test('mapSpotifySearchResults: handles partial result types', () => {
  const mockSearchResponse = {
    tracks: {
      items: [
        {
          id: 'track1',
          name: 'Song 1',
          uri: 'spotify:track:track1',
          type: 'track',
          artists: [{ name: 'Artist 1' }],
        },
      ],
    },
  }

  const result = mapSpotifySearchResults(mockSearchResponse)

  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].type, 'track')
})

test('mapSpotifySearchResults: sets correct URLs for all types', () => {
  const mockSearchResponse = {
    tracks: {
      items: [
        {
          id: 'track123',
          name: 'Song',
          uri: 'spotify:track:track123',
          type: 'track',
          artists: [{ name: 'Artist' }],
        },
      ],
    },
    albums: {
      items: [
        {
          id: 'album456',
          name: 'Album',
          uri: 'spotify:album:album456',
          type: 'album',
          artists: [{ name: 'Artist' }],
        },
      ],
    },
    artists: {
      items: [
        {
          id: 'artist789',
          name: 'Artist Name',
          uri: 'spotify:artist:artist789',
          type: 'artist',
        },
      ],
    },
    playlists: {
      items: [
        {
          id: 'playlist000',
          name: 'Playlist',
          uri: 'spotify:playlist:playlist000',
          type: 'playlist',
          owner: { id: 'user123' },
        },
      ],
    },
  }

  const result = mapSpotifySearchResults(mockSearchResponse)

  const track = result.find((i) => i.type === 'track')
  assert.strictEqual(track?.url, 'https://open.spotify.com/track/track123')

  const album = result.find((i) => i.type === 'album')
  assert.strictEqual(album?.url, 'https://open.spotify.com/album/album456')

  const artist = result.find((i) => i.type === 'artist')
  assert.strictEqual(artist?.url, 'https://open.spotify.com/artist/artist789')

  const playlist = result.find((i) => i.type === 'playlist')
  assert.strictEqual(playlist?.url, 'https://open.spotify.com/playlist/playlist000')
})

test('mapSpotifySearchResults: handles tracks with multiple artists', () => {
  const mockSearchResponse = {
    tracks: {
      items: [
        {
          id: 'track1',
          name: 'Collaboration',
          uri: 'spotify:track:track1',
          type: 'track',
          artists: [
            { name: 'Artist 1' },
            { name: 'Artist 2' },
            { name: 'Artist 3' },
          ],
          duration_ms: 180000,
        },
      ],
    },
  }

  const result = mapSpotifySearchResults(mockSearchResponse)

  assert.strictEqual(result.length, 1)
  const track = result[0]
  assert.ok(track.type === 'track')
  if (track.type === 'track') {
    assert.deepStrictEqual(track.track.artists, ['Artist 1', 'Artist 2', 'Artist 3'])
  }
})

test('mapSpotifySearchResults: includes album and release date info', () => {
  const mockSearchResponse = {
    tracks: {
      items: [
        {
          id: 'track1',
          name: 'Song 1',
          uri: 'spotify:track:track1',
          type: 'track',
          artists: [{ name: 'Artist 1' }],
          duration_ms: 180000,
          album: { name: 'My Album' },
        },
      ],
    },
  }

  const result = mapSpotifySearchResults(mockSearchResponse)

  assert.strictEqual(result.length, 1)
  const track = result[0]
  assert.ok(track.type === 'track')
  if (track.type === 'track') {
    assert.strictEqual(track.track.album, 'My Album')
  }
})

test('mapSpotifySearchResults: includes playlist owner info', () => {
  const mockSearchResponse = {
    playlists: {
      items: [
        {
          id: 'playlist1',
          name: 'My Playlist',
          uri: 'spotify:playlist:playlist1',
          type: 'playlist',
          owner: { id: 'user123', display_name: 'User Name' },
          tracks: { total: 42 },
        },
      ],
    },
  }

  const result = mapSpotifySearchResults(mockSearchResponse)

  assert.strictEqual(result.length, 1)
  const playlist = result[0]
  assert.ok(playlist.type === 'playlist')
  if (playlist.type === 'playlist') {
    assert.deepStrictEqual(playlist.owner, {
      id: 'user123',
      displayName: 'User Name',
    })
  }
})

test('mapSpotifySearchResults: creates proper ref URIs for all types', () => {
  const mockSearchResponse = {
    tracks: {
      items: [
        {
          id: 'abc123',
          name: 'Track',
          uri: 'spotify:track:abc123',
          type: 'track',
          artists: [{ name: 'Artist' }],
        },
      ],
    },
    albums: {
      items: [
        {
          id: 'def456',
          name: 'Album',
          uri: 'spotify:album:def456',
          type: 'album',
          artists: [{ name: 'Artist' }],
        },
      ],
    },
    artists: {
      items: [
        {
          id: 'ghi789',
          name: 'Artist',
          uri: 'spotify:artist:ghi789',
          type: 'artist',
        },
      ],
    },
    playlists: {
      items: [
        {
          id: 'jkl000',
          name: 'Playlist',
          uri: 'spotify:playlist:jkl000',
          type: 'playlist',
          owner: { id: 'user' },
        },
      ],
    },
  }

  const result = mapSpotifySearchResults(mockSearchResponse)

  const refs = result.map((item) => item.ref)
  assert.ok(refs.includes('spotify:track:abc123'))
  assert.ok(refs.includes('spotify:album:def456'))
  assert.ok(refs.includes('spotify:artist:ghi789'))
  assert.ok(refs.includes('spotify:playlist:jkl000'))
})
