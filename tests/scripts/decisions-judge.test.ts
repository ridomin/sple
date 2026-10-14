import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  basicPick,
  choiceRequest,
  choiceShortlist,
  isFatal,
  JudgeError,
  judgeTrack,
  optionText,
  parseResponse,
  readLetters,
  type Ask,
  type Hit,
  type JudgeSettings,
  type SourceTrack,
  type TopLogprob,
} from '../../scripts/spikes/decisions/judge.js'

const SETTINGS: JudgeSettings = { mode: 'choice', k: 3, order: 'provider', durationToleranceMs: 10_000, cap: 0.45, none: 'capped', confidence: 'any' }

/** Top log-probabilities giving these letter probabilities (A, B, C, …). */
function top(...ps: number[]): TopLogprob[] {
  return ps.map((p, i) => ({ token: 'ABCDEFGHIJK'[i], logprob: Math.log(p) })).filter((t) => Number.isFinite(t.logprob))
}

function answering(...ps: number[]): Ask {
  return async () => ({ top: top(...ps), model: 'jevk5', ms: 5 })
}

function run(source: SourceTrack, hits: Hit[], ask: Ask, settings: Partial<JudgeSettings> = {}) {
  return judgeTrack(source, hits, { ...SETTINGS, ...settings }, { model: 'jevk5', targetService: 'YouTube Music', ask })
}

const near = (a: number | undefined, b: number) => assert.ok(Math.abs((a ?? NaN) - b) < 1e-9, `${a} ≠ ${b}`)

function src(seconds?: number): SourceTrack {
  return { service: 'Spotify', title: 'Song', artists: ['Artist'], ...(seconds === undefined ? {} : { durationMs: seconds * 1000 }) }
}
function hit(ref: string, seconds?: number, title = 'Unrelated', artists = ['Nobody']): Hit {
  return { ref, title, artists, ...(seconds === undefined ? {} : { durationMs: seconds * 1000 }) }
}

// A1 §5: this hit scores 0.85 against "Don't Stop Me Now" / Queen / 209 s; the others are not accepted.
const QUEEN: SourceTrack = { service: 'Spotify', title: 'Don’t Stop Me Now', artists: ['Queen'], durationMs: 209_000 }
const REMASTER: Hit = { ref: 'q', title: "Don't Stop Me Now - 2011 Remaster", artists: ['Queen'], durationMs: 216_000 }
const OTHER1 = hit('x1')
const OTHER2 = hit('x2')

type HitCase = [number[], number | undefined, number | undefined, number, number]

async function hitWins(cases: HitCase[], settings: Partial<JudgeSettings> = {}) {
  // p (A, B, C, none), source s, winning hit s, winning index, confidence
  for (const [p, s, h, index, confidence] of cases) {
    const hits = [hit('h1', index === 0 ? h : 1), hit('h2', index === 1 ? h : 1), hit('h3', 1)]
    const outcome = await run(src(s), hits, answering(...p), settings)
    assert.equal(outcome.strategy, 'local', `${p}`)
    assert.equal(outcome.pick?.index, index, `${p}`)
    near(outcome.pick?.confidence, confidence)
  }
}

test('ADR 0009 A3 §7 (confidence any): the most probable hit wins with 1 − p(none)', async () => {
  await hitWins([
    [[0.7, 0.05, 0.05, 0.2], 243, 245, 0, 0.8],
    [[0.1, 0.6, 0.05, 0.25], 200, 208, 1, 0.75],
    [[0.55, 0.05, 0.05, 0.35], 301, 420, 0, 0.45], // Δ 119 s > D
    [[0.48, 0.02, 0.02, 0.48], undefined, 200, 0, 0.52],
    [[0.4, 0.4, 0.1, 0.1], 200, 200, 0, 0.9], // tie: earlier letter
    [[0.25, 0.22, 0.2, 0.33], 200, 200, 0, 0.67], // several uploads split the probability
  ])
})

test('ADR 0009 A3 §7 (confidence any): p(none) ≥ 0.5 means "none"', async () => {
  const outcome = await run(QUEEN, [OTHER1, REMASTER, OTHER2], answering(0.2, 0.2, 0.1, 0.5))
  assert.deepEqual(outcome.pick, { index: 1, confidence: 0.45 })
  assert.equal(outcome.strategy, 'metadata')
})

test('confidence pick: the most probable option wins with its own probability', async () => {
  await hitWins(
    [
      [[0.7, 0.05, 0.05, 0.2], 243, 245, 0, 0.7],
      [[0.1, 0.6, 0.05, 0.25], 200, 208, 1, 0.6],
      [[0.55, 0.05, 0.05, 0.35], 301, 420, 0, 0.45],
      [[0.48, 0.02, 0.02, 0.48], undefined, 200, 0, 0.48], // tie with none: earlier letter
      [[0.4, 0.4, 0.1, 0.1], 200, 200, 0, 0.4],
    ],
    { confidence: 'pick' }
  )
  const split = await run(QUEEN, [OTHER1, REMASTER, OTHER2], answering(0.25, 0.22, 0.2, 0.33), { confidence: 'pick', none: 'unmatched' })
  assert.equal(split.pick, null)
})

test('ADR 0009 A3 §7: "none" keeps the A1 result capped, or nothing', async () => {
  const capped = await run(QUEEN, [OTHER1, REMASTER, OTHER2], answering(0.05, 0.05, 0.05, 0.85))
  assert.deepEqual(capped, { pick: { index: 1, confidence: 0.45 }, strategy: 'metadata', requests: 1, ms: 5, model: 'jevk5' })

  const nothing = await run(QUEEN, [OTHER1, OTHER2, hit('x3')], answering(0.05, 0.05, 0.05, 0.85))
  assert.equal(nothing.pick, null)
})

test('the other "none" rules: unmatched, or the A1 result uncapped', async () => {
  const hits = [OTHER1, REMASTER, OTHER2]
  const none = answering(0.05, 0.05, 0.05, 0.85)
  assert.equal((await run(QUEEN, hits, none, { none: 'unmatched' })).pick, null)
  near((await run(QUEEN, hits, none, { none: 'basic' })).pick?.confidence, 0.85)
})

test('ADR 0009 A3 §7: two hits give options A, B and C = none', async () => {
  let input = ''
  const outcome = await run(src(200), [hit('h1', 200), hit('h2')], async (body) => {
    input = body.input
    return { top: top(0.3, 0.6, 0.1), model: 'jevk5', ms: 1 }
  })
  assert.match(input, /\[C\] None of these is the same recording\.\n/)
  assert.doesNotMatch(input, /\[D\]/)
  assert.equal(outcome.pick?.index, 1)
  near(outcome.pick?.confidence, 0.9)
})

test('ADR 0009 A3 §7: failures fall back to the A1 result uncapped', async () => {
  const thinking = await run(QUEEN, [REMASTER, OTHER1, OTHER2], async () => ({
    top: [{ token: '<think>', logprob: Math.log(0.7) }, ...top(0.3)],
    model: 'jevk5',
    ms: 1,
  }))
  assert.equal(thinking.strategy, 'metadata')
  near(thinking.pick?.confidence, 0.85)
  assert.equal(thinking.error, 'local: no letter answer')

  const timeout = await run(QUEEN, [REMASTER], async () => {
    throw new JudgeError('timed out after 30 s')
  })
  assert.equal(timeout.error, 'local: timed out after 30 s')
  assert.equal(timeout.pick?.index, 0)
})

test('connection failures and HTTP 404 switch the judge off (rethrown)', async () => {
  for (const error of [new JudgeError('connect ECONNREFUSED', undefined, true), new JudgeError('HTTP 404', 404)]) {
    await assert.rejects(run(QUEEN, [REMASTER], async () => {
      throw error
    }))
  }
  assert.equal(isFatal(new JudgeError('HTTP 500', 500)), false)
})

test('ADR 0009 A3 §7 readout: letters and [letters] add up, other tokens are ignored', () => {
  const p = readLetters(
    [
      { token: 'A', logprob: Math.log(0.6) },
      { token: '[A', logprob: Math.log(0.1) },
      { token: 'B', logprob: Math.log(0.15) },
      { token: 'D', logprob: Math.log(0.08) },
      { token: '<think>', logprob: Math.log(0.05) },
    ],
    4
  )
  assert.ok(p)
  const expected = [0.7527, 0.1613, 0, 0.086]
  p.forEach((x, i) => assert.ok(Math.abs(x - expected[i]) < 1e-4, `${i}: ${x}`))
  assert.equal(readLetters([{ token: 'A', logprob: Math.log(0.4) }], 4), null)
})

test('the prompt follows the A3 §3 template', () => {
  const source: SourceTrack = { service: 'Spotify', title: 'Hello', artists: ['Adele'], album: '25', durationMs: 295_000 }
  const hits: Hit[] = [
    { ref: 'yt1', title: 'Adele - Hello (Live at the BBC)', artists: ['Adele'], durationMs: 300_000 },
    { ref: 'yt2', title: 'Hello "Lyrics"', artists: ['Lyric\nChannel', ' '] },
  ]
  const body = choiceRequest('jevk5', source, choiceShortlist(source, hits, SETTINGS))
  assert.equal(
    body.input,
    [
      'State:',
      '{"source":{"service":"Spotify","title":"Hello","artists":["Adele"],"album":"25"}}',
      '',
      "Question: Which candidate is the same recording as the source track? Uploads that differ only in packaging (Official Video, Lyrics, Audio, HD, a '- Topic' or VEVO channel) count as the same recording. Live, remix, cover, karaoke, instrumental, sped up or re-recorded versions do not.",
      'Options:',
      '[A] "Adele - Hello (Live at the BBC)" by Adele',
      '[B] "Hello \\"Lyrics\\"" by Lyric Channel',
      '[C] None of these is the same recording.',
      '',
      'Answer with the letter of the best option only.',
    ].join('\n')
  )
  assert.deepEqual({ ...body, input: '' }, {
    model: 'jevk5',
    input: '',
    max_output_tokens: 2,
    temperature: 0,
    top_logprobs: 20,
    include: ['message.output_text.logprobs'],
    reasoning: { effort: 'none' },
  })
  assert.doesNotMatch(body.input, /yt1|295000|300000/)
  assert.equal(optionText({ title: 'T', artists: [], album: 'X' }), '"T" from "X"')
})

test('the shortlist is the first K hits in provider order, or by A1 score for local-a1', () => {
  const hits = [OTHER1, OTHER2, REMASTER, hit('x3')]
  assert.deepEqual(choiceShortlist(QUEEN, hits, { k: 3, order: 'provider' }).map((e) => e.index), [0, 1, 2])
  assert.deepEqual(choiceShortlist(QUEEN, hits, { k: 2, order: 'a1' }).map((e) => e.index), [2, 0])
})

test('no hits means no request', async () => {
  let calls = 0
  const outcome = await run(QUEEN, [], async () => {
    calls++
    return { top: top(1), model: 'm', ms: 0 }
  })
  assert.equal(outcome.pick, null)
  assert.equal(calls, 0)
})

test('score mode asks one three-level question per gated candidate', async () => {
  const inputs: string[] = []
  const outcome = await run(QUEEN, [hit('x', 209), REMASTER], async (body) => {
    inputs.push(body.input)
    return { top: top(0.05, 0.1, 0.85), model: 'jevk5', ms: 2 }
  }, { mode: 'score' })
  assert.equal(inputs.length, 1) // "Unrelated" by Nobody fails the relaxed gate
  assert.match(inputs[0], /"candidate":\{"service":"YouTube Music"/)
  assert.deepEqual(outcome.pick, { index: 1, confidence: 0.85 })
})

test('parseResponse reads LM Studio /v1/responses bodies', () => {
  const body = {
    model: 'jevk5',
    output: [
      { type: 'reasoning', content: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'B', logprobs: [{ token: 'B', logprob: -0.1, top_logprobs: [{ token: 'B', logprob: -0.1 }] }] }] },
    ],
  }
  assert.deepEqual(parseResponse(body), { top: [{ token: 'B', logprob: -0.1 }], model: 'jevk5' })
  assert.equal(parseResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'B' }] }] }), null)
  assert.equal(parseResponse('nope'), null)
})

test('basicPick is the A1 metadata result', () => {
  const pick = basicPick(QUEEN, [OTHER1, REMASTER])
  assert.equal(pick?.index, 1)
  near(pick?.confidence, 0.85)
})
