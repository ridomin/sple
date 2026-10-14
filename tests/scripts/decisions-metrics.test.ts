import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseBest, measure, passes, row, type Label, type Measures, type RunTrack } from '../../scripts/spikes/decisions/metrics.js'

function run(pick: [number, number] | null, extra: Partial<RunTrack> = {}): RunTrack {
  return { pick: pick && { index: pick[0], confidence: pick[1] }, refusal: false, failed: false, requests: 1, inputTokens: 100, ms: 10, ...extra }
}

const LABELS: Label[][] = [
  ['different', 'same'], // 0
  ['version', 'same'], // 1
  ['different'], // 2: no `same` hit
  ['same'], // 3
  ['same'], // 4
]

test('measure classifies each track at the given threshold', () => {
  const outcomes = [
    run([1, 0.9]), // correct
    run([0, 0.9]), // false accept (version)
    run([0, 0.6], { refusal: true }), // false accept (no `same` hit)
    run([0, 0.45]), // low-confidence
    run(null, { failed: true, requests: 0, inputTokens: 0 }), // missed `same`
  ]
  const m = measure(LABELS, outcomes, 0.5)
  assert.deepEqual(m, {
    tracks: 5,
    correct: 1,
    falseAccept: 2,
    lowConfidence: 1,
    missedSame: 1,
    refusals: 1,
    failures: 1,
    requests: 4,
    inputTokens: 400,
    ms: 50,
  })

  const strict = measure(LABELS, outcomes, 0.8)
  assert.equal(strict.correct, 1)
  assert.equal(strict.falseAccept, 1)
  assert.equal(strict.lowConfidence, 2)
})

test('an unmatched track with no `same` hit is neither missed nor false', () => {
  const m = measure([['different']], [run(null)], 0.5)
  assert.equal(m.missedSame, 0)
  assert.equal(m.falseAccept, 0)
})

function measures(correct: number, falseAccept: number, inputTokens = 0): Measures {
  return { tracks: 100, correct, falseAccept, lowConfidence: 0, missedSame: 0, refusals: 0, failures: 0, requests: 0, inputTokens, ms: 0 }
}

test('passes needs no more false accepts and at least 10 more points of correct accepts', () => {
  const basic = measures(60, 5)
  assert.equal(passes(measures(70, 5), basic), true)
  assert.equal(passes(measures(69, 0), basic), false)
  assert.equal(passes(measures(80, 6), basic), false)
})

test('chooseBest prefers safe settings, then correct accepts, then fewer tokens', () => {
  const basic = measures(60, 5)
  const runs = [
    { name: 'a', measures: measures(90, 9) },
    { name: 'b', measures: measures(75, 5, 900) },
    { name: 'c', measures: measures(75, 4, 500) },
  ]
  assert.equal(chooseBest(runs, basic)?.name, 'c')
  assert.equal(chooseBest([runs[0], { name: 'd', measures: measures(85, 6) }], basic)?.name, 'a')
})

test('row formats rates and leaves judge columns blank for basic', () => {
  assert.equal(
    row('basic', '–', '5', measures(60, 5), false),
    '| basic | – | 5 | 60.0% (60) | 5.0% (5) | 0.0% (0) | 0.0% (0) | – | – |  |'
  )
  assert.match(row('openai', '5', '10', { ...measures(70, 2, 1234), refusals: 1, failures: 2, requests: 100, ms: 4200 }, true), /\| 1 \(\+2 failed\) \| 1234 \(100 req\) \| 4\.2 s \|$/)
})
