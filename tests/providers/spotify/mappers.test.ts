import { test } from 'node:test'
import * as assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProviderError } from '../../../src/core/provider/errors.js'
import {
  mapSpotifyTrackToCanonical,
  mapSpotifyPlaylistItems,
  mapSpotifyPlaylistToSummary,
  determineItemsReadable,
} from '../../../src/providers/spotify/mappers.js'

const __dirname = join(fileURLToPath(import.meta.url), '..')

function loadFixture(filename: string) {
  const path = join(__dirname, '..', '..', 'fixtures', 'spotify', filename)
  const content = readFileSync(path, 'utf-8')
  return JSON.parse(content)
}

test('mapSpotifyTrackToCanonical', async (t) => {
  await t.test('maps a valid track with all fields', () => {
    const track = {
      id: 'track123',
      name: 'Song Title',
      artists: [{ name: 'Artist Name' }],
      album: { name: 'Album Name' },
      duration_ms: 180000,
      uri: 'spotify:track:track123',
    }

    const canonical = mapSpotifyTrackToCanonical(track)

    assert.strictEqual(canonical.title, 'Song Title')
    assert.deepStrictEqual(canonical.artists, ['Artist Name'])
    assert.strictEqual(canonical.album, 'Album Name')
    assert.strictEqual(canonical.durationMs, 180000)
    assert.strictEqual(canonical.isrc, null)
    assert.strictEqual(canonical.refs.spotify, 'spotify:track:track123')
  })

  await t.test('maps multiple artists', () => {
    const track = {
      id: 'track123',
      name: 'Collaboration',
      artists: [{ name: 'Artist 1' }, { name: 'Artist 2' }, { name: 'Artist 3' }],
      uri: 'spotify:track:track123',
    }

    const canonical = mapSpotifyTrackToCanonical(track)

    assert.deepStrictEqual(canonical.artists, ['Artist 1', 'Artist 2', 'Artist 3'])
  })

  await t.test('handles empty artists array by using Unknown Artist', () => {
    const track = {
      id: 'track123',
      name: 'Unknown Track',
      artists: [],
      uri: 'spotify:track:track123',
    }

    const canonical = mapSpotifyTrackToCanonical(track)

    assert.deepStrictEqual(canonical.artists, ['Unknown Artist'])
  })

  await t.test('handles missing duration_ms', () => {
    const track = {
      id: 'track123',
      name: 'Song',
      artists: [{ name: 'Artist' }],
      uri: 'spotify:track:track123',
    }

    const canonical = mapSpotifyTrackToCanonical(track)

    assert.strictEqual(canonical.durationMs, undefined)
  })

  await t.test('handles null duration_ms', () => {
    const track = {
      id: 'track123',
      name: 'Song',
      artists: [{ name: 'Artist' }],
      duration_ms: null,
      uri: 'spotify:track:track123',
    }

    const canonical = mapSpotifyTrackToCanonical(track)

    assert.strictEqual(canonical.durationMs, undefined)
  })

  await t.test('always sets isrc to null per ADR-0005', () => {
    const trackWithIsrc = {
      id: 'track123',
      name: 'Song',
      artists: [{ name: 'Artist' }],
      external_ids: { isrc: 'USRC12345678' },
      uri: 'spotify:track:track123',
    }

    const canonical = mapSpotifyTrackToCanonical(trackWithIsrc)

    assert.strictEqual(canonical.isrc, null)
  })

  await t.test('handles empty track name with default value', () => {
    const track = {
      id: 'track123',
      name: '',
      artists: [{ name: 'Artist' }],
      uri: 'spotify:track:track123',
    }

    const canonical = mapSpotifyTrackToCanonical(track)

    assert.strictEqual(canonical.title, '(untitled)')
  })

  await t.test('handles empty track uri with default value', () => {
    const track = {
      id: 'track123',
      name: 'Song',
      artists: [{ name: 'Artist' }],
      uri: '',
    }

    const canonical = mapSpotifyTrackToCanonical(track)

    assert.strictEqual(canonical.refs.spotify, '(no uri)')
  })

  await t.test('throws ProviderError on missing id', () => {
    const track = {
      name: 'Song',
      artists: [{ name: 'Artist' }],
      uri: 'spotify:track:track123',
    }

    assert.throws(() => mapSpotifyTrackToCanonical(track), ProviderError)
  })

  await t.test('throws ProviderError on missing name', () => {
    const track = {
      id: 'track123',
      artists: [{ name: 'Artist' }],
      uri: 'spotify:track:track123',
    }

    assert.throws(() => mapSpotifyTrackToCanonical(track), ProviderError)
  })

  await t.test('throws ProviderError on missing uri', () => {
    const track = {
      id: 'track123',
      name: 'Song',
      artists: [{ name: 'Artist' }],
    }

    assert.throws(() => mapSpotifyTrackToCanonical(track), ProviderError)
  })

  await t.test('throws ProviderError if artists is not an array', () => {
    const track = {
      id: 'track123',
      name: 'Song',
      artists: 'Artist Name',
      uri: 'spotify:track:track123',
    }

    assert.throws(() => mapSpotifyTrackToCanonical(track), ProviderError)
  })

  await t.test('throws ProviderError if artist missing name', () => {
    const track = {
      id: 'track123',
      name: 'Song',
      artists: [{ id: 'artist123' }],
      uri: 'spotify:track:track123',
    }

    assert.throws(() => mapSpotifyTrackToCanonical(track), ProviderError)
  })
})

test('mapSpotifyPlaylistItems', async (t) => {
  await t.test('maps a simple valid item with track', () => {
    const items = [
      {
        added_at: '2026-01-01T00:00:00Z',
        is_local: false,
        item: {
          id: 'track123',
          name: 'Song',
          artists: [{ name: 'Artist' }],
          uri: 'spotify:track:track123',
          type: 'track',
        },
      },
    ]

    const mapped = mapSpotifyPlaylistItems(items)

    assert.strictEqual(mapped.length, 1)
    assert.strictEqual(mapped[0].position, 1)
    assert.ok(mapped[0].track)
    assert.strictEqual(mapped[0].track?.title, 'Song')
    assert.strictEqual(mapped[0].unsupported, undefined)
  })

  await t.test('copies added_at onto the track as addedAt', () => {
    const item = (added_at?: string) => ({
      ...(added_at ? { added_at } : {}),
      is_local: false,
      item: { id: 't1', name: 'Song', artists: [{ name: 'A' }], uri: 'spotify:track:t1', type: 'track' },
    })
    const [withDate, withoutDate] = mapSpotifyPlaylistItems([item('2026-04-15T12:28:26Z'), item()])
    assert.strictEqual(withDate.track?.addedAt, '2026-04-15T12:28:26Z')
    assert.strictEqual(withoutDate.track?.addedAt, undefined)
  })

  await t.test('tracks position numbering starting from 1', () => {
    const items = [
      {
        is_local: false,
        item: {
          id: 'track1',
          name: 'Song1',
          artists: [{ name: 'Artist1' }],
          uri: 'spotify:track:track1',
          type: 'track',
        },
      },
      {
        is_local: false,
        item: {
          id: 'track2',
          name: 'Song2',
          artists: [{ name: 'Artist2' }],
          uri: 'spotify:track:track2',
          type: 'track',
        },
      },
    ]

    const mapped = mapSpotifyPlaylistItems(items)

    assert.strictEqual(mapped[0].position, 1)
    assert.strictEqual(mapped[1].position, 2)
  })

  await t.test('supports custom startPosition', () => {
    const items = [
      {
        is_local: false,
        item: {
          id: 'track1',
          name: 'Song1',
          artists: [{ name: 'Artist1' }],
          uri: 'spotify:track:track1',
          type: 'track',
        },
      },
    ]

    const mapped = mapSpotifyPlaylistItems(items, 50)

    assert.strictEqual(mapped[0].position, 50)
  })

  await t.test('marks is_local=true as unsupported local', () => {
    const items = [
      {
        is_local: true,
        item: {
          id: 'local123',
          name: 'Local Song',
          uri: 'local song path',
          type: 'track',
        },
      },
    ]

    const mapped = mapSpotifyPlaylistItems(items)

    assert.strictEqual(mapped[0].position, 1)
    assert.strictEqual(mapped[0].unsupported?.kind, 'local')
    assert.strictEqual(mapped[0].unsupported?.name, 'Local Song')
    assert.strictEqual(mapped[0].unsupported?.ref, 'local song path')
    assert.strictEqual(mapped[0].track, undefined)
  })

  await t.test('handles null item as unavailable', () => {
    const items = [
      {
        is_local: false,
        item: null,
      },
    ]

    const mapped = mapSpotifyPlaylistItems(items)

    assert.strictEqual(mapped[0].position, 1)
    assert.strictEqual(mapped[0].unsupported?.kind, 'unavailable')
    assert.strictEqual(mapped[0].track, undefined)
  })

  await t.test('marks episode type as unsupported', () => {
    const items = [
      {
        is_local: false,
        item: {
          id: 'episode123',
          name: 'Episode Title',
          type: 'episode',
        },
      },
    ]

    const mapped = mapSpotifyPlaylistItems(items)

    assert.strictEqual(mapped[0].position, 1)
    assert.strictEqual(mapped[0].unsupported?.kind, 'episode')
    assert.strictEqual(mapped[0].unsupported?.name, 'Episode Title')
    assert.strictEqual(mapped[0].unsupported?.ref, 'spotify:episode:episode123')
    assert.strictEqual(mapped[0].track, undefined)
  })

  await t.test('handles mixed items (tracks and unsupported)', () => {
    const items = [
      {
        is_local: false,
        item: {
          id: 'track1',
          name: 'Song 1',
          artists: [{ name: 'Artist 1' }],
          uri: 'spotify:track:track1',
          type: 'track',
        },
      },
      {
        is_local: true,
        item: {
          id: 'local1',
          name: 'Local Song',
          uri: 'local path',
          type: 'track',
        },
      },
      {
        is_local: false,
        item: null,
      },
      {
        is_local: false,
        item: {
          id: 'episode1',
          name: 'Podcast Episode',
          type: 'episode',
        },
      },
      {
        is_local: false,
        item: {
          id: 'track2',
          name: 'Song 2',
          artists: [{ name: 'Artist 2' }],
          uri: 'spotify:track:track2',
          type: 'track',
        },
      },
    ]

    const mapped = mapSpotifyPlaylistItems(items)

    assert.strictEqual(mapped.length, 5)
    assert.strictEqual(mapped[0].track?.title, 'Song 1')
    assert.strictEqual(mapped[1].unsupported?.kind, 'local')
    assert.strictEqual(mapped[2].unsupported?.kind, 'unavailable')
    assert.strictEqual(mapped[3].unsupported?.kind, 'episode')
    assert.strictEqual(mapped[4].track?.title, 'Song 2')
  })

  await t.test('throws ProviderError if items is not an array', () => {
    assert.throws(() => mapSpotifyPlaylistItems({ items: [] }), ProviderError)
  })
})

test('mapSpotifyPlaylistToSummary', async (t) => {
  await t.test('maps a valid playlist', () => {
    const playlist = {
      id: 'playlist123',
      name: 'My Playlist',
      description: 'A test playlist',
      owner: {
        id: 'user123',
        display_name: 'Test User',
      },
      items: {
        total: 42,
      },
    }

    const summary = mapSpotifyPlaylistToSummary(playlist, 'user123', true)

    assert.strictEqual(summary.ref, 'playlist123')
    assert.strictEqual(summary.id, 'playlist123')
    assert.strictEqual(summary.name, 'My Playlist')
    assert.strictEqual(summary.description, 'A test playlist')
    assert.strictEqual(summary.owner.id, 'user123')
    assert.strictEqual(summary.owner.displayName, 'Test User')
    assert.strictEqual(summary.owned, true)
    assert.strictEqual(summary.itemsReadable, true)
    assert.strictEqual(summary.trackCount, 42)
    assert.strictEqual(summary.url, 'https://open.spotify.com/playlist/playlist123')
  })

  await t.test('determines ownership by comparing owner.id with userId', () => {
    const playlist = {
      id: 'playlist123',
      name: 'My Playlist',
      owner: { id: 'user123' },
      items: { total: 10 },
    }

    const ownedSummary = mapSpotifyPlaylistToSummary(playlist, 'user123', false)
    assert.strictEqual(ownedSummary.owned, true)

    const unownedSummary = mapSpotifyPlaylistToSummary(playlist, 'otherUser', false)
    assert.strictEqual(unownedSummary.owned, false)
  })

  await t.test('uses itemsReadable parameter as-is', () => {
    const playlist = {
      id: 'playlist123',
      name: 'Playlist',
      owner: { id: 'user123' },
      items: { total: 5 },
    }

    const readable = mapSpotifyPlaylistToSummary(playlist, 'currentUser', true)
    assert.strictEqual(readable.itemsReadable, true)

    const notReadable = mapSpotifyPlaylistToSummary(playlist, 'currentUser', false)
    assert.strictEqual(notReadable.itemsReadable, false)
  })

  await t.test('extracts trackCount from items.total', () => {
    const playlist = {
      id: 'playlist123',
      name: 'Playlist',
      owner: { id: 'user123' },
      items: { total: 100 },
    }

    const summary = mapSpotifyPlaylistToSummary(playlist, 'user123', true)
    assert.strictEqual(summary.trackCount, 100)
  })

  await t.test('handles missing items.total gracefully', () => {
    const playlist = {
      id: 'playlist123',
      name: 'Playlist',
      owner: { id: 'user123' },
    }

    const summary = mapSpotifyPlaylistToSummary(playlist, 'user123', true)
    assert.strictEqual(summary.trackCount, undefined)
  })

  await t.test('throws ProviderError on missing id', () => {
    const playlist = {
      name: 'Playlist',
      owner: { id: 'user123' },
    }

    assert.throws(() => mapSpotifyPlaylistToSummary(playlist, 'user123', true), ProviderError)
  })

  await t.test('throws ProviderError on missing name', () => {
    const playlist = {
      id: 'playlist123',
      owner: { id: 'user123' },
    }

    assert.throws(() => mapSpotifyPlaylistToSummary(playlist, 'user123', true), ProviderError)
  })

  await t.test('throws ProviderError on missing owner', () => {
    const playlist = {
      id: 'playlist123',
      name: 'Playlist',
    }

    assert.throws(() => mapSpotifyPlaylistToSummary(playlist, 'user123', true), ProviderError)
  })

  await t.test('throws ProviderError on missing owner.id', () => {
    const playlist = {
      id: 'playlist123',
      name: 'Playlist',
      owner: { display_name: 'User' },
    }

    assert.throws(() => mapSpotifyPlaylistToSummary(playlist, 'user123', true), ProviderError)
  })

  await t.test('handles empty playlist name with default value', () => {
    const playlist = {
      id: 'playlist123',
      name: '',
      owner: { id: 'user123', display_name: 'Test User' },
      items: { total: 5 },
    }

    const summary = mapSpotifyPlaylistToSummary(playlist, 'user123', true)

    assert.strictEqual(summary.name, '(untitled)')
    assert.strictEqual(summary.id, 'playlist123')
  })
})

test('determineItemsReadable', async (t) => {
  await t.test("'all' always returns true", () => {
    assert.strictEqual(determineItemsReadable('all', false, false), true)
    assert.strictEqual(determineItemsReadable('all', true, false), true)
    assert.strictEqual(determineItemsReadable('all', false, true), true)
    assert.strictEqual(determineItemsReadable('all', true, true), true)
  })

  await t.test("'owned-only' returns true only when owned", () => {
    assert.strictEqual(determineItemsReadable('owned-only', true, false), true)
    assert.strictEqual(determineItemsReadable('owned-only', true, true), true)
    assert.strictEqual(determineItemsReadable('owned-only', false, false), false)
    assert.strictEqual(determineItemsReadable('owned-only', false, true), false)
  })

  await t.test("'owned-or-collaborator' returns true when owned or collaborative", () => {
    assert.strictEqual(determineItemsReadable('owned-or-collaborator', true, false), true)
    assert.strictEqual(determineItemsReadable('owned-or-collaborator', true, true), true)
    assert.strictEqual(determineItemsReadable('owned-or-collaborator', false, true), true)
    assert.strictEqual(determineItemsReadable('owned-or-collaborator', false, false), false)
  })
})

test('mappers with S2 fixtures', async (t) => {
  await t.test('maps S2 owned playlist', () => {
    const fixture = loadFixture('s2-owned-pl.json')
    const playlist = fixture.body

    const summary = mapSpotifyPlaylistToSummary(playlist, 'testuser0000000000000', true)

    assert.strictEqual(summary.id, '0FRr10mglUR3E0Pq8TqlxL')
    assert.strictEqual(summary.name, 'FlamenRock')
    assert.strictEqual(summary.owner.id, 'testuser0000000000000')
    assert.strictEqual(summary.owned, true)
  })

  await t.test('maps S2 owned playlist items', () => {
    const fixture = loadFixture('s2-owned-items.json')
    const items = fixture.body.items

    const mapped = mapSpotifyPlaylistItems(items)

    assert.ok(mapped.length > 0)
    // First item should be a track
    const firstItem = mapped[0]
    assert.ok(firstItem.track)
    assert.strictEqual(firstItem.position, 1)
    assert.strictEqual(firstItem.track?.title, 'Las Leyes De La Frontera')
  })

  await t.test('maps S2 collab playlist items', () => {
    const fixture = loadFixture('s2-collab-items.json')
    const items = fixture.body.items

    const mapped = mapSpotifyPlaylistItems(items)

    assert.ok(mapped.length > 0)
    const firstItem = mapped[0]
    assert.ok(firstItem.track)
    assert.strictEqual(firstItem.track?.title, 'Volver')
  })
})
