import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYouTubeTrackRef } from '../../../src/providers/youtube-music/playlist-ref.js'
import { createYouTubeMusicProvider } from '../../../src/providers/youtube-music/index.js'

// ADR-0003 §3.1: canonical YouTube track ref is the bare 11-char video ID.
const ID = 'dQw4w9WgXcQ'

test('parseYouTubeTrackRef accepts the §3.1 forms and returns the video ID', () => {
  for (const input of [
    ID,
    `https://www.youtube.com/watch?v=${ID}`,
    `http://youtube.com/watch?v=${ID}&list=PLabcdefghijklm`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&si=x`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=42`,
    `  ${ID} `,
  ]) {
    assert.equal(parseYouTubeTrackRef(input), ID, input)
  }
})

test('parseYouTubeTrackRef rejects other inputs', () => {
  for (const input of [
    'Never Gonna Give You Up',
    'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
    `https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf`,
    `https://example.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=short`,
    'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
  ]) {
    assert.equal(parseYouTubeTrackRef(input), null, input)
  }
})

test('the YouTube provider exposes parseTrackRef', () => {
  assert.equal(createYouTubeMusicProvider('cid', 'secret').parseTrackRef(`https://youtu.be/${ID}`), ID)
})
