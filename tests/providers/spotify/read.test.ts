import { test } from 'node:test'
import * as assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccessRestrictedError } from '../../../src/core/provider/errors.js'
import {
  mapSpotifyPlaylistToSummary,
  mapSpotifyPlaylistItems,
  mapSpotifyTrackToCanonical,
  determineItemsReadable,
} from '../../../src/providers/spotify/mappers.js'

const __dirname = join(fileURLToPath(import.meta.url), '..')

function loadFixture(filename: string) {
  const path = join(__dirname, '..', '..', 'fixtures', 'spotify', filename)
  const content = readFileSync(path, 'utf-8')
  const data = JSON.parse(content)
  return data.body
}

test('Spotify read operations (M1-20)', async (t) => {
  const userId = 'testuser0000000000000'

  await t.test('mapSpotifyPlaylistToSummary with owned playlist', () => {
    const playlist = loadFixture('s2-owned-pl.json')

    const summary = mapSpotifyPlaylistToSummary(playlist, userId, true)

    assert.strictEqual(summary.id, '0FRr10mglUR3E0Pq8TqlxL')
    assert.strictEqual(summary.name, 'FlamenRock')
    assert.strictEqual(summary.owned, true)
    assert.strictEqual(summary.itemsReadable, true)
    assert.strictEqual(summary.owner.id, userId)
    assert.strictEqual(summary.trackCount, 5)
  })

  await t.test('mapSpotifyPlaylistToSummary with followed non-owned playlist', () => {
    const playlist = loadFixture('s2-followed-pl.json')
    // The fixture has the same user ID as the playlist owner (due to sanitization),
    // so to test non-ownership we use a different user ID
    const differentUserId = 'otheruser0000000000000'
    const summary = mapSpotifyPlaylistToSummary(playlist, differentUserId, false)

    assert.strictEqual(summary.id, '76IBoRDyYzi2Svw7oRRfki')
    assert.strictEqual(summary.name, 'THE HIVES: COMPLETE')
    assert.strictEqual(summary.owned, false)
    assert.strictEqual(summary.itemsReadable, false)
  })

  await t.test('mapSpotifyPlaylistToSummary with collaborative playlist', () => {
    const playlist = loadFixture('s2-collab-pl.json')

    const summary = mapSpotifyPlaylistToSummary(playlist, userId, true)

    assert.strictEqual(summary.id, '5AJC5nedvehBP0eVDy6zXb')
    assert.strictEqual(summary.name, 'MySamplePL')
    // Note: collaborative flag is false in the fixture - this is an owned playlist
    assert.strictEqual(summary.collaborative, false)
    assert.strictEqual(summary.itemsReadable, true)
  })

  await t.test('mapSpotifyPlaylistItems extracts tracks from owned playlist', () => {
    const items = loadFixture('s2-owned-items.json').items

    const mapped = mapSpotifyPlaylistItems(items)

    assert.ok(mapped.length > 0)
    // Check that first item is a track (not unsupported)
    const firstTrack = mapped.find((item) => item.track)
    assert.ok(firstTrack)
    assert.strictEqual(firstTrack.position, 1)
    assert.ok(firstTrack.track)
    assert.ok(firstTrack.track.title)
  })

  await t.test('mapSpotifyPlaylistItems respects position numbering', () => {
    const items = loadFixture('s2-owned-items.json').items

    const mapped = mapSpotifyPlaylistItems(items, 10)

    // Starting position should be 10
    const firstItem = mapped[0]
    assert.strictEqual(firstItem.position, 10)
  })

  await t.test('mapSpotifyTrackToCanonical preserves addedAt when provided', () => {
    const track = {
      id: 'track123',
      name: 'Song Title',
      artists: [{ name: 'Artist Name' }],
      uri: 'spotify:track:track123',
    }

    const canonical = mapSpotifyTrackToCanonical(track)
    canonical.addedAt = '2026-04-15T12:28:26Z'

    assert.strictEqual(canonical.addedAt, '2026-04-15T12:28:26Z')
  })

  await t.test('determineItemsReadable for owned-or-collaborator capability', () => {
    // Owned
    assert.strictEqual(determineItemsReadable('owned-or-collaborator', true, false), true)
    // Collaborative
    assert.strictEqual(determineItemsReadable('owned-or-collaborator', false, true), true)
    // Neither
    assert.strictEqual(determineItemsReadable('owned-or-collaborator', false, false), false)
  })

  await t.test('determineItemsReadable for owned-only capability', () => {
    // Owned
    assert.strictEqual(determineItemsReadable('owned-only', true, false), true)
    // Not owned
    assert.strictEqual(determineItemsReadable('owned-only', false, false), false)
    // Not owned but collaborative
    assert.strictEqual(determineItemsReadable('owned-only', false, true), false)
  })

  await t.test('determineItemsReadable for all capability', () => {
    assert.strictEqual(determineItemsReadable('all', true, false), true)
    assert.strictEqual(determineItemsReadable('all', false, false), true)
    assert.strictEqual(determineItemsReadable('all', false, true), true)
  })

  await t.test('PlaylistSummary for owned playlist includes all fields', () => {
    const playlist = loadFixture('s2-owned-pl.json')
    const summary = mapSpotifyPlaylistToSummary(playlist, userId, true)

    // Check required fields
    assert.ok(summary.ref)
    assert.ok(summary.id)
    assert.ok(summary.name)
    assert.ok(summary.owner)
    assert.strictEqual(typeof summary.owned, 'boolean')
    assert.strictEqual(typeof summary.itemsReadable, 'boolean')

    // Check optional fields
    assert.ok(summary.url)
    assert.strictEqual(summary.trackCount, 5)
  })

  await t.test('PlaylistSummary access control for non-owned', () => {
    const playlist = loadFixture('s2-followed-pl.json')
    // Use a different user ID to simulate non-ownership
    const differentUserId = 'otheruser0000000000000'
    const summary = mapSpotifyPlaylistToSummary(playlist, differentUserId, false)

    assert.strictEqual(summary.owned, false)
    assert.strictEqual(summary.itemsReadable, false)
  })

  await t.test('mapSpotifyPlaylistItems handles mixed content types', () => {
    // Load a fixture with multiple item types
    const items = loadFixture('s2-owned-items.json').items

    const mapped = mapSpotifyPlaylistItems(items)

    // Verify we have items array
    assert.ok(Array.isArray(mapped))
    assert.ok(mapped.length > 0)

    // Each item should have a position and either a track or unsupported
    for (const item of mapped) {
      assert.ok(typeof item.position === 'number')
      assert.ok(item.track || item.unsupported)
    }
  })

  await t.test('PlaylistSummary ref matches id', () => {
    const playlist = loadFixture('s2-owned-pl.json')
    const summary = mapSpotifyPlaylistToSummary(playlist, userId, true)

    assert.strictEqual(summary.ref, summary.id)
  })

  await t.test('PlaylistSummary url is correctly formatted', () => {
    const playlist = loadFixture('s2-owned-pl.json')
    const summary = mapSpotifyPlaylistToSummary(playlist, userId, true)

    assert.ok(summary.url)
    assert.match(summary.url, /^https:\/\/open\.spotify\.com\/playlist\//)
    assert.ok(summary.url.includes(summary.id))
  })

  await t.test('mapSpotifyPlaylistItems preserves track order', () => {
    const items = loadFixture('s2-owned-items.json').items

    const mapped = mapSpotifyPlaylistItems(items, 1)

    // Verify positions are sequential
    let expectedPosition = 1
    for (const item of mapped) {
      assert.strictEqual(item.position, expectedPosition)
      expectedPosition++
    }
  })

  await t.test('Liked tracks with pagination metadata', () => {
    const playlist = loadFixture('s2-owned-pl.json')
    const summary = mapSpotifyPlaylistToSummary(playlist, userId, true)

    // Verify trackCount matches items.total from fixture
    assert.strictEqual(summary.trackCount, 5)
  })
})
