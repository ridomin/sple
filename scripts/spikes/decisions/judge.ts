// Spike S8: the ADR 0009 Amendment 3 local judge (shortlist, prompt, readout, combine, fallback), harness-only.
// Pure apart from the injected `ask`; the implementation PR moves this into src/core/matching.
import { scoreMetadata, type MetadataScore } from '../../../src/core/matching/normalizer.js'

export interface SourceTrack {
  service: string
  title: string
  artists: string[]
  album?: string
  durationMs?: number
}

/** One provider search hit, as saved in the fixture (provider order). */
export interface Hit {
  ref: string
  title: string
  artists: string[]
  album?: string
  durationMs?: number
}

/** What the strategy does when the judge answers "none" (A3 §4). */
export type NoneRule = 'unmatched' | 'basic' | 'capped'

export interface JudgeSettings {
  /** `choice`: one question over the top K (A3). `score`: the earlier per-candidate rating, for comparison. */
  mode: 'choice' | 'score'
  k: number
  /** Choice shortlist order: the provider's (A3 §2) or the A1 score's. */
  order: 'provider' | 'a1'
  /** Duration tolerance D, in ms. */
  durationToleranceMs: number
  cap: number
  none: NoneRule
}

export interface TopLogprob {
  token: string
  logprob: number
}

/** The first output token's top log-probabilities, as read from a /responses body. */
export interface AskResult {
  top: TopLogprob[]
  model: string
  ms: number
}

export interface JudgeRequest {
  model: string
  input: string
  max_output_tokens: number
  temperature: number
  top_logprobs: number
  include: string[]
  reasoning: { effort: 'none' }
}

export type Ask = (body: JudgeRequest) => Promise<AskResult>

export interface HitPick {
  /** Position in the provider's hit list. */
  index: number
  confidence: number
}

export interface TrackOutcome {
  pick: HitPick | null
  strategy: 'local' | 'metadata'
  /** `local: <message>` after a fallback. */
  error?: string
  /** Number of judge requests sent. */
  requests: number
  ms: number
  model?: string
}

/** Thrown by the client. `connection` or HTTP 404 switches the judge off for the run (A3 §5). */
export class JudgeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly connection = false
  ) {
    super(message)
  }
}

export function isFatal(error: unknown): boolean {
  return error instanceof JudgeError && (error.connection || error.status === 404)
}

const LETTERS = 'ABCDEFGHIJK'

// Provisional wording (A3 §3, spike S8).
export const QUESTION =
  'Which candidate is the same recording as the source track? Uploads that differ only in packaging ' +
  "(Official Video, Lyrics, Audio, HD, a '- Topic' or VEVO channel) count as the same recording. " +
  'Live, remix, cover, karaoke, instrumental, sped up or re-recorded versions do not.'
export const NONE_OPTION = 'None of these is the same recording.'

const SCORE_QUESTION =
  'How does the candidate relate to the source track as a recording? ' +
  "Ignore words that only describe the upload, such as 'Official Video', 'Lyrics', 'Audio', 'HD' or a channel suffix like 'VEVO' or '- Topic'."
const SCORE_LEVELS = [
  'A different song.',
  'The same song but a different recording or version: live, remix, cover, acoustic, instrumental, karaoke, sped up or slowed, or re-recorded.',
  "The same recording as the source; only the upload's packaging differs.",
]

function record(service: string, t: { title: string; artists: string[]; album?: string }) {
  return { service, title: t.title, artists: t.artists, ...(t.album ? { album: t.album } : {}) }
}

/** A3 §3: a hit as one option line. Whitespace runs in artist names collapse so nothing can start a new line. */
export function optionText(hit: Pick<Hit, 'title' | 'artists' | 'album'>): string {
  const artists = hit.artists.map((a) => a.replace(/\s+/g, ' ').trim()).filter((a) => a.length > 0)
  return JSON.stringify(hit.title) + (artists.length > 0 ? ` by ${artists.join(', ')}` : '') + (hit.album ? ` from ${JSON.stringify(hit.album)}` : '')
}

export function buildPrompt(state: unknown, question: string, options: string[]): string {
  return [
    'State:',
    JSON.stringify(state),
    '',
    `Question: ${question}`,
    'Options:',
    ...options.map((o, i) => `[${LETTERS[i]}] ${o}`),
    '',
    'Answer with the letter of the best option only.',
  ].join('\n')
}

export function requestBody(model: string, input: string): JudgeRequest {
  return {
    model,
    input,
    max_output_tokens: 2,
    temperature: 0,
    top_logprobs: 20,
    include: ['message.output_text.logprobs'],
    reasoning: { effort: 'none' },
  }
}

/** A3 §3 "Reading the answer", step 1: the first output token's top log-probabilities, or null. */
export function parseResponse(body: unknown): { top: TopLogprob[]; model: string } | null {
  const b = body as {
    model?: unknown
    output?: Array<{ type?: string; content?: Array<{ type?: string; logprobs?: Array<{ top_logprobs?: TopLogprob[] }> }> }>
  }
  const message = Array.isArray(b?.output) ? b.output.find((o) => o?.type === 'message') : undefined
  const part = message?.content?.find((c) => c?.type === 'output_text')
  const top = part?.logprobs?.[0]?.top_logprobs
  if (!Array.isArray(top)) return null
  return { top, model: typeof b.model === 'string' ? b.model : '' }
}

/** A3 §3 steps 2–4: one probability per option letter, or null when the letters carry less than half the mass. */
export function readLetters(top: TopLogprob[], options: number): number[] | null {
  const mass = Array.from(LETTERS.slice(0, options), (letter) =>
    top.filter((t) => t.token.trim().replace(/^\[/, '') === letter).reduce((sum, t) => sum + Math.exp(t.logprob), 0)
  )
  const total = mass.reduce((a, b) => a + b, 0)
  return total < 0.5 ? null : mass.map((m) => m / total)
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

interface Entry {
  index: number
  hit: Hit
  score: MetadataScore
}

/** A3 §2 (provider order), or the top K by A1 confidence (`local-a1`). */
export function choiceShortlist(source: SourceTrack, hits: Hit[], settings: Pick<JudgeSettings, 'k' | 'order'>): Entry[] {
  const entries = hits.map((hit, index) => ({ hit, index, score: scoreMetadata(source, hit) }))
  if (settings.order === 'a1') entries.sort((x, y) => y.score.confidence - x.score.confidence) // stable
  return entries.slice(0, settings.k)
}

/** The earlier design's shortlist: relaxed gate `t > 0 || a > 0`, sorted by A1 confidence. */
export function scoreShortlist(source: SourceTrack, hits: Hit[], k: number): Entry[] {
  return hits
    .map((hit, index) => ({ hit, index, score: scoreMetadata(source, hit) }))
    .filter(({ score }) => score.title > 0 || score.artist > 0)
    .sort((x, y) => y.score.confidence - x.score.confidence)
    .slice(0, k)
}

export function choiceRequest(model: string, source: SourceTrack, list: Entry[]): JudgeRequest {
  const state = { source: record(source.service, source) }
  return requestBody(model, buildPrompt(state, QUESTION, [...list.map((e) => optionText(e.hit)), NONE_OPTION]))
}

export function scoreRequest(model: string, source: SourceTrack, targetService: string, hit: Hit): JudgeRequest {
  const state = { source: record(source.service, source), candidate: record(targetService, hit) }
  return requestBody(model, buildPrompt(state, SCORE_QUESTION, SCORE_LEVELS))
}

function durationOk(source: SourceTrack, hit: Hit, toleranceMs: number): boolean {
  return (
    typeof source.durationMs !== 'number' ||
    typeof hit.durationMs !== 'number' ||
    Math.abs(source.durationMs - hit.durationMs) <= toleranceMs
  )
}

/** A3 §4. `p` has one entry per shortlisted hit plus "none" last. */
export function combineChoice(
  source: SourceTrack,
  hits: Hit[],
  list: Entry[],
  p: number[],
  settings: Pick<JudgeSettings, 'durationToleranceMs' | 'cap' | 'none'>
): Pick<TrackOutcome, 'pick' | 'strategy'> {
  let win = 0
  for (let i = 1; i < p.length; i++) if (p[i] > p[win]) win = i
  if (win < list.length) {
    const { hit, index } = list[win]
    const confidence = durationOk(source, hit, settings.durationToleranceMs) ? p[win] : Math.min(p[win], settings.cap)
    return { pick: { index, confidence }, strategy: 'local' }
  }
  if (settings.none === 'unmatched') return { pick: null, strategy: 'local' }
  const basic = basicPick(source, hits)
  if (basic && settings.none === 'capped') basic.confidence = Math.min(basic.confidence, settings.cap)
  return { pick: basic, strategy: 'metadata' }
}

/** The earlier per-candidate rule (three levels, `score = p1 + 2·p2`, level = round half up). */
function combineScores(source: SourceTrack, list: Entry[], ps: number[][], settings: Pick<JudgeSettings, 'durationToleranceMs' | 'cap'>): HitPick | null {
  let best: HitPick | null = null
  list.forEach((e, i) => {
    const [, p1, p2] = ps[i]
    const level = Math.floor(p1 + 2 * p2 + 0.5)
    if (level <= 0) return
    const confidence = level >= 2 && durationOk(source, e.hit, settings.durationToleranceMs) ? p2 : Math.min(p2, settings.cap)
    if (!best || confidence > best.confidence) best = { index: e.index, confidence }
  })
  return best
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The `local` strategy for one track's saved hits. Falls back to the A1 result
 * on any failure (A3 §5) and rethrows the errors that switch the judge off.
 */
export async function judgeTrack(
  source: SourceTrack,
  hits: Hit[],
  settings: JudgeSettings,
  deps: { model: string; targetService: string; ask: Ask }
): Promise<TrackOutcome> {
  const outcome: TrackOutcome = { pick: null, strategy: 'local', requests: 0, ms: 0 }
  const list = settings.mode === 'choice' ? choiceShortlist(source, hits, settings) : scoreShortlist(source, hits, settings.k)
  if (list.length === 0) return outcome

  const bodies =
    settings.mode === 'choice'
      ? [choiceRequest(deps.model, source, list)]
      : list.map((e) => scoreRequest(deps.model, source, deps.targetService, e.hit))
  const options = settings.mode === 'choice' ? list.length + 1 : 3

  const fallback = (error: string): TrackOutcome => ({ ...outcome, pick: basicPick(source, hits), strategy: 'metadata', error: `local: ${error}` })
  const ps: number[][] = []
  for (const body of bodies) {
    let result: AskResult
    try {
      result = await deps.ask(body)
    } catch (error) {
      if (isFatal(error)) throw error
      return fallback(message(error))
    }
    outcome.requests++
    outcome.ms += result.ms
    outcome.model ??= result.model
    const p = readLetters(result.top, options)
    if (!p) return fallback('no letter answer')
    ps.push(p)
  }

  if (settings.mode === 'score') return { ...outcome, pick: combineScores(source, list, ps, settings) }
  return { ...outcome, ...combineChoice(source, hits, list, ps[0], settings) }
}
