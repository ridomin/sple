import { test } from 'node:test'
import assert from 'node:assert/strict'
import { videoTrackMetadata, isTopicChannel } from '../../../src/providers/youtube-music/track-metadata.js'
import { scoreMetadata } from '../../../src/core/matching/normalizer.js'

// ADR-0002 R3 heuristics (#29): turn a video's title and channel into track metadata.

test('Topic channels: the channel (minus " - Topic") is the artist; the title is kept, dashes included', () => {
  assert.deepEqual(videoTrackMetadata('Escombros', 'Mártires del Compás - Topic'), {
    title: 'Escombros',
    artists: ['Mártires del Compás'],
  })
  assert.deepEqual(videoTrackMetadata('Let It Be - Remastered 2009', 'The Beatles - Topic'), {
    title: 'Let It Be - Remastered 2009',
    artists: ['The Beatles'],
  })
  assert.equal(isTopicChannel('The Beatles - Topic'), true)
  assert.equal(isTopicChannel('TheBeatlesVEVO'), false)
})

test('"Artist - Title" uploads are split, credits become artists, video decorations are dropped', () => {
  assert.deepEqual(
    videoTrackMetadata('Sleaford Mods ft. Billy Nomates - Mork n Mindy (Official Video)', 'Sleaford Mods'),
    { title: 'Mork n Mindy', artists: ['Sleaford Mods', 'Billy Nomates'] }
  )
  assert.deepEqual(videoTrackMetadata('IDLES & LCD Soundsystem – Dancer [Official Audio]', 'IDLES'), {
    title: 'Dancer',
    artists: ['IDLES', 'LCD Soundsystem'],
  })
  assert.deepEqual(videoTrackMetadata('Adele - Hello (Lyrics)', 'SomeLyricsChannel'), { title: 'Hello', artists: ['Adele'] })
})

test('other uploads: the cleaned title, and the channel without a VEVO suffix as the artist', () => {
  assert.deepEqual(videoTrackMetadata('Las Leyes De La Frontera (Official Music Video)', 'DerbyMotoretasBKVEVO'), {
    title: 'Las Leyes De La Frontera',
    artists: ['DerbyMotoretasBK'],
  })
  assert.deepEqual(videoTrackMetadata('Hello (Live)', 'Adele'), { title: 'Hello (Live)', artists: ['Adele'] })
})

test('the #29 examples now score as accepted matches', () => {
  const mork = videoTrackMetadata('Sleaford Mods ft. Billy Nomates - Mork n Mindy (Official Video)', 'Sleaford Mods')
  const score = scoreMetadata({ title: 'Mork n Mindy', artists: ['Sleaford Mods', 'Billy Nomates'] }, mork)
  assert.equal(score.accepted, true)
  assert.equal(score.confidence, 1)

  const dancer = videoTrackMetadata('IDLES & LCD Soundsystem – Dancer [Official Audio]', 'IDLES')
  assert.equal(scoreMetadata({ title: 'Dancer', artists: ['IDLES', 'LCD Soundsystem'] }, dancer).accepted, true)
})
