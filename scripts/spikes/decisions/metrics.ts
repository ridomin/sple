// Spike S8: the evaluation measures (protocol step 5) and the pass bar (step 6).
import type { HitPick } from './judge.js'

export type Label = 'same' | 'version' | 'different'

export interface RunTrack {
  pick: HitPick | null
  /** The judge failed and the track fell back to `basic`. */
  failed: boolean
  requests: number
  ms: number
}

export interface Measures {
  tracks: number
  /** `matched` and labelled `same`. */
  correct: number
  /** `matched` and labelled `version` or `different` (includes tracks with no `same` hit). */
  falseAccept: number
  lowConfidence: number
  /** `unmatched` although some hit is labelled `same`. */
  missedSame: number
  failures: number
  requests: number
  ms: number
}

/** `labels[t][i]` is the label of track t's hit i; `outcomes[t]` is the run's result for track t. */
export function measure(labels: Label[][], outcomes: RunTrack[], minConfidence: number): Measures {
  const m: Measures = {
    tracks: outcomes.length,
    correct: 0,
    falseAccept: 0,
    lowConfidence: 0,
    missedSame: 0,
    failures: 0,
    requests: 0,
    ms: 0,
  }
  outcomes.forEach((o, t) => {
    if (o.pick === null) {
      if (labels[t].includes('same')) m.missedSame++
    } else if (o.pick.confidence < minConfidence) {
      m.lowConfidence++
    } else if (labels[t][o.pick.index] === 'same') {
      m.correct++
    } else {
      m.falseAccept++
    }
    if (o.failed) m.failures++
    m.requests += o.requests
    m.ms += o.ms
  })
  return m
}

/** Percentage of tracks, in points. */
export function rate(n: number, m: Measures): number {
  return m.tracks === 0 ? 0 : (100 * n) / m.tracks
}

/** Step 6: false accepts ≤ basic and correct accepts ≥ basic + 10 points, at the default threshold. */
export function passes(candidate: Measures, basic: Measures): boolean {
  return candidate.falseAccept <= basic.falseAccept && rate(candidate.correct, candidate) >= rate(basic.correct, basic) + 10
}

/**
 * The best setting at the default threshold: most correct accepts among those with
 * no more false accepts than `basic`, then fewest false accepts. Falls back to the best
 * correct-minus-false when no setting keeps false accepts down.
 */
export function chooseBest<T extends { measures: Measures }>(runs: T[], basic: Measures): T | undefined {
  const safe = runs.filter((r) => r.measures.falseAccept <= basic.falseAccept)
  const pool = safe.length > 0 ? safe : runs
  const value = (r: T) => (safe.length > 0 ? r.measures.correct : r.measures.correct - r.measures.falseAccept)
  return [...pool].sort((a, b) => value(b) - value(a) || a.measures.falseAccept - b.measures.falseAccept)[0]
}

function pct(n: number, m: Measures): string {
  return `${rate(n, m).toFixed(1)}% (${n})`
}

/** One row of the spike's results table. Time is the mean judge latency per track. */
export function row(name: string, k: string, d: string, none: string, m: Measures, withJudge: boolean): string {
  const cells = [
    name,
    k,
    d,
    none,
    pct(m.correct, m),
    pct(m.falseAccept, m),
    pct(m.lowConfidence, m),
    pct(m.missedSame, m),
    withJudge ? String(m.failures) : '–',
    withJudge ? `${(m.tracks === 0 ? 0 : m.ms / m.tracks / 1000).toFixed(2)} s` : '–',
  ]
  return `| ${cells.join(' | ')} |`
}

export const TABLE_HEADER = [
  '| Run | K | D (s) | "none" | Correct accept | False accept | Low-conf | Missed `same` | Failures | Time/track |',
  '|---|---|---|---|---|---|---|---|---|---|',
].join('\n')
