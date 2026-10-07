import { test, describe } from 'node:test'
import * as assert from 'node:assert'
import {
  normalizeText,
  titleTokens,
  scoreMetadata,
} from '../../../src/core/matching/normalizer.js'

// ADR-0009 Amendment 1 §3–5. The tables below are the spec's test vectors.

describe('normalizeText (ADR-0009 A1 §3)', () => {
  const vectors: [string, string][] = [
    ['Beyoncé', 'beyonce'],
    ['Don’t Stop Me Now', 'dont stop me now'],
    ['Simon & Garfunkel', 'simon and garfunkel'],
    ['ＡＢＣ　Ｄｅｆ', 'abc def'],
    ['Hello,  World!', 'hello world'],
    ['Mötley Crüe', 'motley crue'],
  ]
  for (const [input, expected] of vectors) {
    test(`${input} → ${expected}`, () => assert.strictEqual(normalizeText(input), expected))
  }

  // #30: accents and typographic punctuation fold to the same text.
  test('folds accents, apostrophes and dashes (#30)', () => {
    assert.strictEqual(normalizeText('Mártires del Compás - Topic'), 'martires del compas topic')
    assert.strictEqual(normalizeText('MARTIRES DEL COMPAS'), 'martires del compas')
    assert.strictEqual(normalizeText('Derby Motoreta’s'), normalizeText("Derby Motoreta's"))
    assert.strictEqual(normalizeText('ʼ‘a’'), 'a')
    assert.strictEqual(normalizeText('a – b — c'), 'a b c')
    assert.strictEqual(normalizeText('São João'), 'sao joao')
  })
})

describe('titleTokens (ADR-0009 A1 §3)', () => {
  const vectors: [string, string[]][] = [
    ['Let It Be - Remastered 2009', ['let', 'it', 'be']],
    ['Don’t Stop Me Now - 2011 Remaster', ['dont', 'stop', 'me', 'now']],
    ['Señorita (feat. Camila Cabello)', ['senorita']],
    ['Old Town Road (with Billy Ray Cyrus) [Remix]', ['old', 'town', 'road', 'remix']],
    ['Hello (Live)', ['hello', 'live']],
    ['Song - With You', ['song', 'with', 'you']],
    ['Track [Explicit] - Radio Edit', ['track']],
    ['Bohemian Rhapsody - Remastered 2011 - Mono', ['bohemian', 'rhapsody']],
    ['Up & Up (feat. X) - Digitally Remastered', ['up', 'and']],
  ]
  for (const [input, expected] of vectors) {
    test(input, () => assert.deepStrictEqual(titleTokens(input), expected))
  }
})

describe('scoreMetadata (ADR-0009 A1 §4)', () => {
  type Side = [title: string, artists: string[], ms?: number]
  const vectors: [Side, Side, number, number, number, boolean][] = [
    [['Let It Be - Remastered 2009', ['The Beatles'], 243000], ['Let It Be', ['The Beatles'], 243026], 1, 1, 1, true],
    [['Halo', ['Beyoncé']], ['Halo', ['Beyonce']], 1, 1, 1, true],
    [['Don’t Stop Me Now', ['Queen'], 209000], ["Don't Stop Me Now - 2011 Remaster", ['Queen'], 216000], 1, 1, 0.85, true],
    [
      ['Señorita (feat. Camila Cabello)', ['Shawn Mendes', 'Camila Cabello'], 190799],
      ['Señorita', ['Shawn Mendes', 'Camila Cabello'], 190800],
      1, 1, 1, true,
    ],
    [['Yesterday', ['The Beatles'], 125000], ['Hey Jude', ['The Beatles'], 125000], 0, 1, 0.5, false],
    [['Hallelujah', ['Leonard Cohen'], 280000], ['Hallelujah', ['Jeff Buckley'], 280000], 1, 0, 0.65, false],
    [['The Boxer', ['Simon & Garfunkel']], ['The Boxer', ['Simon and Garfunkel']], 1, 1, 1, true],
    [['Hello (Live)', ['Adele'], 300000], ['Hello', ['Adele'], 295500], 0.5, 1, 0.75, true],
    [['Come Together', ['Beatles']], ['Come Together', ['The Beatles']], 1, 1, 1, true],
    [['Under Pressure', ['Queen', 'David Bowie'], 248000], ['Under Pressure', ['Queen'], 260000], 1, 0.5, 0.675, true],
    [['Smells Like Teen Spirit', ['Nirvana'], 301000], ['Smells Like Teen Spirit (Live)', ['Nirvana'], 420000], 0.8, 1, 0.75, true],
  ]
  for (const [[st, sa, sd], [ct, ca, cd], t, a, confidence, accepted] of vectors) {
    test(`${st} / ${sa.join(', ')} vs ${ct} / ${ca.join(', ')}`, () => {
      const score = scoreMetadata({ title: st, artists: sa, durationMs: sd }, { title: ct, artists: ca, durationMs: cd })
      assert.ok(Math.abs(score.title - t) < 1e-9, `title ${score.title}`)
      assert.ok(Math.abs(score.artist - a) < 1e-9, `artist ${score.artist}`)
      assert.ok(Math.abs(score.confidence - confidence) < 1e-9, `confidence ${score.confidence}`)
      assert.strictEqual(score.accepted, accepted)
    })
  }

  // #25: matching artist and duration no longer carry an unrelated title.
  test('rejects a candidate whose title shares nothing with the source (#25)', () => {
    const score = scoreMetadata(
      { title: 'Full Speed Go', artists: ['Scumbag Millionaire'], durationMs: 127106 },
      { title: 'Scumbag Millionaire - Attitude (Live in Uddevalla)', artists: ['Scumbag Millionaire'], durationMs: 125000 }
    )
    assert.strictEqual(score.title, 0)
    assert.strictEqual(score.accepted, false)
  })

  // #30: accents in the artist no longer cost the artist score.
  test('scores an accented artist as a full artist match (#30)', () => {
    const score = scoreMetadata(
      { title: 'Escombros', artists: ['MARTIRES DEL COMPAS'], durationMs: 196653 },
      { title: 'Escombros', artists: ['Mártires del Compás - Topic'], durationMs: 197000 }
    )
    assert.strictEqual(score.artist, 1)
    assert.ok(Math.abs(score.confidence - 1) < 1e-9)
  })

  test('an empty title or artist list scores 0 and is not accepted', () => {
    assert.strictEqual(scoreMetadata({ title: '', artists: ['A'] }, { title: 'X', artists: ['A'] }).accepted, false)
    assert.strictEqual(scoreMetadata({ title: 'X', artists: [] }, { title: 'X', artists: ['A'] }).artist, 0)
  })
})
