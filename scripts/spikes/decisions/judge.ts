// Spike S8: the ADR 0009 Amendment 3 judge (shortlist, request, combine, fallback), harness-only.
// Pure apart from the injected `ask`; the implementation PR moves this into src/core/matching.
import { scoreMetadata, type MetadataScore } from '../../../src/core/matching/normalizer.js'

export interface SourceTrack {
  service: string
  title: string
  artists: string[]
  album?: string
  durationMs?: number
}

/** One provider search hit, as saved in the fixture. */
export interface Hit {
  ref: string
  title: string
  artists: string[]
  album?: string
  durationMs?: number
}

export interface JudgeSettings {
  /** Shortlist size. */
  k: number
  /** Duration tolerance D, in ms. */
  durationToleranceMs: number
  /** Confidence cap for level 1 and for level 2 that fails the duration check. */
  cap: number
  /** `relaxed` = A3 §2 (`t > 0 || a > 0`); `none` keeps every hit. */
  gate: 'relaxed' | 'none'
  /** One request per (track, candidate) instead of one per track. */
  pair?: boolean
}

export interface Shortlisted {
  /** `c1…cK`. */
  key: string
  /** Position in the provider's hit list. */
  index: number
  hit: Hit
  score: MetadataScore
}

export type Answer =
  | {
      type: 'score'
      name: string | null
      score: number
      confidence: number
      probabilities: Array<{ value: number; label: string; probability: number }>
    }
  | { type: 'refusal'; name: string | null }
  | { type: 'predicate' | 'choice'; name: string | null }

export interface ScoreQuestion {
  type: 'score'
  name: string
  instructions: string
  levels: Array<{ label: string; description: string }>
}

export interface DecisionRequest {
  model: string
  input: string
  questions: ScoreQuestion[]
}

export interface AskResult {
  answers: Answer[]
  model: string
  inputTokens: number
  ms: number
}

export type Ask = (body: DecisionRequest) => Promise<AskResult>

export interface HitPick {
  /** Position in the provider's hit list. */
  index: number
  confidence: number
}

export interface TrackOutcome {
  pick: HitPick | null
  strategy: 'openai' | 'metadata'
  /** `openai: <message>` after a fallback. */
  error?: string
  refusal: boolean
  /** Number of Decisions requests sent. */
  requests: number
  inputTokens: number
  ms: number
  model?: string
}

// Provisional wording (A3 §3, spike S8).
const LEVELS = [
  { label: 'different', description: 'A different song.' },
  {
    label: 'version',
    description:
      'The same song but a different recording or version: live, remix, cover, acoustic, instrumental, karaoke, sped up or slowed, or re-recorded.',
  },
  { label: 'same', description: "The same recording as the source; only the upload's packaging differs." },
]

function instructions(key: string): string {
  return (
    `The input is JSON with a source track and candidate tracks. How does candidate ${key} relate to the source track as a recording? ` +
    "Ignore words that only describe the upload, such as 'Official Video', 'Lyrics', 'Audio', 'HD' or a channel suffix like 'VEVO' or '- Topic'."
  )
}

/** A3 §2, steps 2–3. */
export function shortlist(source: SourceTrack, hits: Hit[], settings: JudgeSettings): Shortlisted[] {
  return hits
    .map((hit, index) => ({ hit, index, score: scoreMetadata(source, hit) }))
    .filter(({ score }) => settings.gate === 'none' || score.title > 0 || score.artist > 0)
    .sort((x, y) => y.score.confidence - x.score.confidence) // stable: ties keep provider order
    .slice(0, settings.k)
    .map((s, i) => ({ ...s, key: `c${i + 1}` }))
}

function record(service: string, t: { title: string; artists: string[]; album?: string }) {
  return { service, title: t.title, artists: t.artists, ...(t.album ? { album: t.album } : {}) }
}

/** A3 §3. Durations, refs and ISRCs are never sent. */
export function buildRequest(model: string, source: SourceTrack, targetService: string, list: Shortlisted[]): DecisionRequest {
  const candidates = Object.fromEntries(list.map((s) => [s.key, record(targetService, s.hit)]))
  return {
    model,
    input: JSON.stringify({ source: record(source.service, source), candidates }),
    questions: list.map((s) => ({ type: 'score', name: s.key, instructions: instructions(s.key), levels: LEVELS })),
  }
}

export type CombineResult =
  | { ok: true; pick: (HitPick & { key: string }) | null }
  | { ok: false; refusal: boolean; message: string }

/** A3 §4. */
export function combine(
  source: { durationMs?: number },
  list: Shortlisted[],
  answers: Answer[],
  settings: Pick<JudgeSettings, 'durationToleranceMs' | 'cap'>
): CombineResult {
  const byName = new Map(answers.map((a) => [a.name, a]))
  let best: (HitPick & { key: string }) | null = null
  for (const s of list) {
    const answer = byName.get(s.key)
    if (answer?.type === 'refusal') return { ok: false, refusal: true, message: `refusal for ${s.key}` }
    if (answer?.type !== 'score') return { ok: false, refusal: false, message: `no answer for ${s.key}` }
    const p2 = answer.probabilities.find((p) => p.value === 2)?.probability
    if (p2 === undefined) return { ok: false, refusal: false, message: `no probability for value 2 in ${s.key}` }

    const level = Math.floor(answer.score + 0.5)
    if (level <= 0) continue
    const durationOk =
      typeof source.durationMs !== 'number' ||
      typeof s.hit.durationMs !== 'number' ||
      Math.abs(source.durationMs - s.hit.durationMs) <= settings.durationToleranceMs
    const confidence = level >= 2 && durationOk ? p2 : Math.min(p2, settings.cap)
    if (!best || confidence > best.confidence) best = { key: s.key, index: s.index, confidence }
  }
  return { ok: true, pick: best }
}


/** A1 §4: the `basic` metadata result over the same hits. */
export function basicPick(source: SourceTrack, hits: Hit[]): HitPick | null {
  let best: HitPick | null = null
  hits.forEach((hit, index) => {
    const score = scoreMetadata(source, hit)
    if (score.accepted && (!best || score.confidence > best.confidence)) best = { index, confidence: score.confidence }
  })
  return best
}

/** A3 §5: errors that switch OpenAI off for the run. */
export function isFatal(error: unknown): boolean {
  const e = error as { status?: number; code?: string; error?: { code?: string } } | null
  const status = e?.status
  if (status === 401 || status === 403 || status === 404) return true
  return status === 429 && (e?.code ?? e?.error?.code) === 'insufficient_quota'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The `openai` strategy for one track's saved hits. Falls back to the A1 result
 * on any failure (A3 §5) and rethrows the errors that would switch OpenAI off.
 */
export async function judgeTrack(
  source: SourceTrack,
  hits: Hit[],
  settings: JudgeSettings,
  deps: { model: string; targetService: string; ask: Ask }
): Promise<TrackOutcome> {
  const list = shortlist(source, hits, settings)
  const outcome: TrackOutcome = { pick: null, strategy: 'openai', refusal: false, requests: 0, inputTokens: 0, ms: 0 }
  if (list.length === 0) return outcome

  const fallback = (error: string, refusal: boolean): TrackOutcome => ({
    ...outcome,
    pick: basicPick(source, hits),
    strategy: 'metadata',
    error: `openai: ${error}`,
    refusal,
  })

  const batches = settings.pair ? list.map((s) => [s]) : [list]
  const answers: Answer[] = []
  for (const batch of batches) {
    let result: AskResult
    try {
      result = await deps.ask(buildRequest(deps.model, source, deps.targetService, batch))
    } catch (error) {
      if (isFatal(error)) throw error
      return fallback(message(error), false)
    }
    outcome.requests++
    outcome.inputTokens += result.inputTokens
    outcome.ms += result.ms
    outcome.model ??= result.model
    answers.push(...result.answers)
  }

  const combined = combine(source, list, answers, settings)
  if (!combined.ok) return fallback(combined.message, combined.refusal)
  outcome.pick = combined.pick && { index: combined.pick.index, confidence: combined.pick.confidence }
  return outcome
}
