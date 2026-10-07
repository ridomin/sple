import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSpotifyTrackRef } from '../../../src/providers/spotify/playlist-ref.js'
import { createSpotifyProvider } from '../../../src/providers/spotify/index.js'

// ADR-0003 §3.1: canonical Spotify track ref is spotify:track:<22-char id>.
const ID = '4uLU6hMCjMI75M1A2tKUQC'

test('parseSpotifyTrackRef accepts the §3.1 forms and returns the canonical URI', () => {
  for (const input of [
    ID,
    `spotify:track:${ID}`,
    `https://open.spotify.com/track/${ID}`,
    `http://open.spotify.com/track/${ID}/`,
    `https://open.spotify.com/intl-de/track/${ID}?si=abc#x`,
    `  ${ID}  `,
  ]) {
    assert.equal(parseSpotifyTrackRef(input), `spotify:track:${ID}`, input)
  }
})

test('parseSpotifyTrackRef rejects other inputs', () => {
  for (const input of [
    'Never Gonna Give You Up',
    `spotify:playlist:${ID}`,
    `https://open.spotify.com/playlist/${ID}`,
    `https://example.com/track/${ID}`,
    'spotify:track:short',
    `ftp://open.spotify.com/track/${ID}`,
    'dQw4w9WgXcQ',
  ]) {
    assert.equal(parseSpotifyTrackRef(input), null, input)
  }
})

test('the Spotify provider exposes parseTrackRef', () => {
  assert.equal(createSpotifyProvider('cid').parseTrackRef(ID), `spotify:track:${ID}`)
})
