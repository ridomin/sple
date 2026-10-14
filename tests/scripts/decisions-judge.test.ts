import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  basicPick,
  buildRequest,
  combine,
  isFatal,
  judgeTrack,
  shortlist,
  type Answer,
  type Hit,
  type Shortlisted,
  type SourceTrack,
} from '../../scripts/spikes/decisions/judge.js'

const SETTINGS = { k: 5, durationToleranceMs: 10_000, cap: 0.45, gate: 'relaxed' as const }

function score(name: string, s: number, p2: number): Answer {
  return {
    type: 'score',
    name,
    score: s,
    confidence: p2,
    probabilities: [
      { value: 0, label: 'different', probability: (1 - p2) / 2 },
      { value: 1, label: 'version', probability: (1 - p2) / 2 },
      { value: 2, label: 'same', probability: p2 },
    ],
  }
}

/** A shortlist entry with only the fields combine() reads. */
function entry(i: number, durationS?: number): Shortlisted {
  return {
    key: `c${i}`,
    index: i - 1,
    hit: { ref: `r${i}`, title: 'Song', artists: ['A'], durationMs: durationS === undefined ? undefined : durationS * 1000 },
    score: { title: 1, artist: 1, confidence: 1, accepted: true },
  }
}

// ADR 0009 Amendment 3 §7. Each row: source s, [score, p2, candidate s] per candidate, expected [key, confidence] or null.
const VECTORS: Array<[number | undefined, Array<[number, number, number]>, [string, number] | null]> = [
  [243, [[1.9, 0.92, 245]], ['c1', 0.92]],
  [243, [[1.2, 0.3, 243]], ['c1', 0.3]],
  [301, [[1.8, 0.85, 420]], ['c1', 0.45]],
  [undefined, [[1.5, 0.48, 200]], ['c1', 0.48]],
  [200, [[0.4, 0.05, 200]], null],
  [200, [[1.7, 0.8, 201], [1.95, 0.93, 199]], ['c2', 0.93]],
  [200, [[1.9, 0.9, 200], [1.9, 0.9, 200]], ['c1', 0.9]],
  [200, [[1.1, 0.4, 200], [0.2, 0.02, 200]], ['c1', 0.4]],
  [200, [[1.99, 0.97, 230]], ['c1', 0.45]],
]

test('combine reproduces the ADR 0009 A3 §7 vectors', () => {
  for (const [sourceS, cands, expected] of VECTORS) {
    const list = cands.map(([, , cs], i) => entry(i + 1, cs))
    const answers = cands.map(([s, p2], i) => score(`c${i + 1}`, s, p2))
    const result = combine({ durationMs: sourceS === undefined ? undefined : sourceS * 1000 }, list, answers, SETTINGS)
    assert.equal(result.ok, true)
    if (!result.ok) continue
    if (expected === null) {
      assert.equal(result.pick, null)
    } else {
      assert.equal(result.pick?.key, expected[0])
      assert.ok(Math.abs((result.pick?.confidence ?? -1) - expected[1]) < 1e-9, `${expected[0]}: ${result.pick?.confidence}`)
    }
  }
})

test('combine matches answers by name, not position', () => {
  const list = [entry(1, 200), entry(2, 200)]
  const result = combine({ durationMs: 200_000 }, list, [score('c2', 1.9, 0.9), score('c1', 0.1, 0.01)], SETTINGS)
  assert.ok(result.ok)
  assert.equal(result.pick?.key, 'c2')
})

test('combine fails on a refusal, a missing answer, or a missing value-2 entry', () => {
  const list = [entry(1, 200), entry(2, 200)]
  const refusal = combine({}, list, [score('c1', 1.9, 0.9), { type: 'refusal', name: 'c2' }], SETTINGS)
  assert.deepEqual(refusal, { ok: false, refusal: true, message: 'refusal for c2' })

  const missing = combine({}, list, [score('c1', 1.9, 0.9)], SETTINGS)
  assert.deepEqual(missing, { ok: false, refusal: false, message: 'no answer for c2' })

  const noP2 = score('c2', 1.9, 0.9)
  if (noP2.type === 'score') noP2.probabilities = noP2.probabilities.filter((p) => p.value !== 2)
  const noValue2 = combine({}, list, [score('c1', 1.9, 0.9), noP2], SETTINGS)
  assert.deepEqual(noValue2, { ok: false, refusal: false, message: 'no probability for value 2 in c2' })
})

const SOURCE: SourceTrack = { service: 'Spotify', title: 'Hello', artists: ['Adele'], album: '25', durationMs: 295_000 }

test('shortlist applies the relaxed gate, sorts stably by A1 confidence and keeps K', () => {
  const hits: Hit[] = [
    { ref: 'a', title: 'Goodbye', artists: ['Someone'] }, // t = 0, a = 0: dropped
    { ref: 'b', title: 'Hello (Live)', artists: ['Adele'], durationMs: 295_000 },
    { ref: 'c', title: 'Hello', artists: ['Adele'], durationMs: 295_000 },
    { ref: 'd', title: 'Rolling in the Deep', artists: ['Adele'] }, // a > 0 only
    { ref: 'e', title: 'Hello', artists: ['Adele'], durationMs: 295_000 }, // ties c, keeps provider order
  ]
  const list = shortlist(SOURCE, hits, { ...SETTINGS, k: 3 })
  assert.deepEqual(list.map((s) => [s.key, s.hit.ref, s.index]), [['c1', 'c', 2], ['c2', 'e', 4], ['c3', 'b', 1]])

  assert.equal(shortlist(SOURCE, hits, { ...SETTINGS, gate: 'none' }).length, 5)
  assert.deepEqual(shortlist(SOURCE, [hits[0]], SETTINGS), [])
})

test('buildRequest sends title, artists and album only, one score question per candidate', () => {
  const hits: Hit[] = [
    { ref: 'yt1', title: 'Adele - Hello (Official Music Video)', artists: ['Adele'], durationMs: 367_000 },
    { ref: 'yt2', title: 'Hello', artists: ['Adele'], album: '25' },
  ]
  const list = shortlist(SOURCE, hits, SETTINGS)
  const body = buildRequest('gpt-6-luna', SOURCE, 'YouTube Music', list)

  assert.equal(body.model, 'gpt-6-luna')
  assert.equal(
    body.input,
    JSON.stringify({
      source: { service: 'Spotify', title: 'Hello', artists: ['Adele'], album: '25' },
      candidates: {
        c1: { service: 'YouTube Music', title: 'Hello', artists: ['Adele'], album: '25' },
        c2: { service: 'YouTube Music', title: 'Adele - Hello (Official Music Video)', artists: ['Adele'] },
      },
    })
  )
  assert.equal(body.questions.length, 2)
  assert.deepEqual(body.questions.map((q) => q.name), ['c1', 'c2'])
  const q = body.questions[1]
  assert.equal(q.type, 'score')
  assert.match(q.instructions, /candidate c2 relate/)
  assert.deepEqual(q.levels.map((l) => l.label), ['different', 'version', 'same'])
  assert.ok(!('safety_identifier' in body))
  assert.doesNotMatch(body.input, /yt1|367000|295000/)
})

// A1 §5: this candidate scores 0.85 against "Don't Stop Me Now" / Queen / 209 s.
const QUEEN: SourceTrack = { service: 'Spotify', title: 'Don’t Stop Me Now', artists: ['Queen'], durationMs: 209_000 }
const REMASTER: Hit = { ref: 'q1', title: "Don't Stop Me Now - 2011 Remaster", artists: ['Queen'], durationMs: 216_000 }
const LIVE: Hit = { ref: 'q0', title: 'Stop (Live)', artists: ['Queen'], durationMs: 400_000 }

test('basicPick is the A1 metadata result', () => {
  const pick = basicPick(QUEEN, [LIVE, REMASTER])
  assert.equal(pick?.index, 1)
  assert.ok(Math.abs((pick?.confidence ?? 0) - 0.85) < 1e-9)
})

test('judgeTrack falls back to the A1 result on a refusal', async () => {
  const outcome = await judgeTrack(QUEEN, [REMASTER, LIVE], SETTINGS, {
    model: 'gpt-6-luna',
    targetService: 'YouTube Music',
    ask: async () => ({ answers: [score('c1', 1.9, 0.92), { type: 'refusal', name: 'c2' }], model: 'gpt-6-luna', inputTokens: 300, ms: 5 }),
  })
  assert.equal(outcome.strategy, 'metadata')
  assert.equal(outcome.pick?.index, 0)
  assert.ok(Math.abs((outcome.pick?.confidence ?? 0) - 0.85) < 1e-9)
  assert.equal(outcome.refusal, true)
  assert.match(outcome.error ?? '', /^openai: /)
  assert.equal(outcome.inputTokens, 300)
})

test('judgeTrack falls back to the A1 result when the request fails', async () => {
  const outcome = await judgeTrack(QUEEN, [LIVE, REMASTER], SETTINGS, {
    model: 'gpt-6-luna',
    targetService: 'YouTube Music',
    ask: async () => {
      throw Object.assign(new Error('500 Internal Server Error'), { status: 500 })
    },
  })
  assert.equal(outcome.strategy, 'metadata')
  assert.equal(outcome.pick?.index, 1)
  assert.equal(outcome.refusal, false)
  assert.equal(outcome.error, 'openai: 500 Internal Server Error')
})

test('judgeTrack rethrows errors that switch OpenAI off for the run', async () => {
  for (const err of [{ status: 401 }, { status: 403 }, { status: 404 }, { status: 429, code: 'insufficient_quota' }]) {
    await assert.rejects(
      judgeTrack(QUEEN, [REMASTER], SETTINGS, {
        model: 'm',
        targetService: 'YouTube Music',
        ask: async () => {
          throw Object.assign(new Error('nope'), err)
        },
      })
    )
  }
  assert.equal(isFatal(Object.assign(new Error('slow down'), { status: 429, code: 'rate_limit_exceeded' })), false)
})

test('judgeTrack picks with the openai strategy, maps back to provider order, and skips empty shortlists', async () => {
  let calls = 0
  const ask = async () => {
    calls++
    return { answers: [score('c1', 1.95, 0.93)], model: 'gpt-6-luna', inputTokens: 200, ms: 7 }
  }
  const outcome = await judgeTrack(QUEEN, [{ ref: 'x', title: 'Other', artists: ['Nobody'] }, REMASTER], SETTINGS, {
    model: 'gpt-6-luna',
    targetService: 'YouTube Music',
    ask,
  })
  assert.equal(outcome.strategy, 'openai')
  assert.deepEqual(outcome.pick, { index: 1, confidence: 0.93 })
  assert.equal(outcome.model, 'gpt-6-luna')

  const empty = await judgeTrack(QUEEN, [{ ref: 'x', title: 'Other', artists: ['Nobody'] }], SETTINGS, {
    model: 'gpt-6-luna',
    targetService: 'YouTube Music',
    ask,
  })
  assert.equal(empty.pick, null)
  assert.equal(calls, 1)
})

test('judgeTrack in pair mode asks one question per request and combines the answers', async () => {
  const bodies: string[] = []
  const outcome = await judgeTrack(QUEEN, [LIVE, REMASTER], { ...SETTINGS, pair: true }, {
    model: 'gpt-6-luna',
    targetService: 'YouTube Music',
    ask: async (body) => {
      bodies.push(body.input as string)
      const name = body.questions[0].name ?? ''
      return { answers: [name === 'c1' ? score('c1', 1.9, 0.9) : score('c2', 1.0, 0.2)], model: 'gpt-6-luna', inputTokens: 100, ms: 3 }
    },
  })
  assert.equal(bodies.length, 2)
  assert.ok(bodies.every((b) => Object.keys(JSON.parse(b).candidates).length === 1))
  assert.deepEqual(outcome.pick, { index: 1, confidence: 0.9 }) // c1 is the remaster (higher A1 score)
  assert.equal(outcome.inputTokens, 200)
  assert.equal(outcome.ms, 6)
})
