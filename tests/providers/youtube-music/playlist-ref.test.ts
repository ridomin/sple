import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYouTubePlaylistId } from '../../../src/providers/youtube-music/playlist-ref.js'

const LONG_ID = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'
// IDs from the API can be as short as 13 chars (#26)
const SHORT_ID = 'PLp1fQ2aB3cD4'

test('parseYouTubePlaylistId', async (t) => {
  const cases: Array<[string, string | null]> = [
    [LONG_ID, LONG_ID],
    [SHORT_ID, SHORT_ID],
    [`  ${LONG_ID}\n`, LONG_ID],
    [`https://www.youtube.com/playlist?list=${LONG_ID}`, LONG_ID],
    [`https://youtube.com/playlist?list=${SHORT_ID}`, SHORT_ID],
    [`https://music.youtube.com/playlist?list=${LONG_ID}`, LONG_ID],
    [`https://m.youtube.com/playlist?list=${LONG_ID}&si=abc`, LONG_ID],
    [`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${LONG_ID}`, LONG_ID],
    ['My playlist', null],
    ['Rock', null],
    ['', null],
    [`https://example.com/playlist?list=${LONG_ID}`, null],
    ['https://www.youtube.com/playlist', null],
    ['https://www.youtube.com/playlist?list=not a valid id', null],
    // list= must pass the same check as a bare ID
    ['https://music.youtube.com/playlist?list=abc', null],
    [`ftp://www.youtube.com/playlist?list=${LONG_ID}`, null],
  ]

  for (const [input, expected] of cases) {
    await t.test(JSON.stringify(input), () => {
      assert.equal(parseYouTubePlaylistId(input), expected)
    })
  }
})
