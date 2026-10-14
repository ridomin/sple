// Spike S8, steps 4–6: run `basic` and the local judge offline against the labelled fixture.
// Usage: npx tsx scripts/spikes/decisions/evaluate.ts [--model <id>] [--url <base>] [--k 3,5] [--d 5,10,15]
//          [--none unmatched,basic,capped] [--cap 0.45] [--skip-a1] [--skip-score] [--skip-repeat]
//          [--concurrency 1] [--dry-run] [--dir <dir>]
// The model and URL default to SPLE_LOCAL_JUDGE_MODEL and SPLE_LOCAL_JUDGE_URL (environment or the sple .env;
// URL default http://localhost:1234/v1). Responses are cached in <dir>/responses.json, so changing D, the cap or
// the "none" rule never asks the model again; the stability repeat always does.
// Prints counts and rates only (Markdown), ready to paste into docs/spikes/local-judge-spike.md.
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { loadEnvFile } from '../../../src/cli/config.js'
import { ageWarning, fixtureDir, labelledTracks, loadFixture, loadResponses, saveResponses, type FixtureTrack } from './fixture.js'
import {
  basicPick,
  choiceRequest,
  choiceShortlist,
  JudgeError,
  judgeTrack,
  parseResponse,
  scoreShortlist,
  type Ask,
  type JudgeRequest,
  type JudgeSettings,
  type NoneRule,
} from './judge.js'
import { chooseBest, measure, passes, row, TABLE_HEADER, type Label, type Measures, type RunTrack } from './metrics.js'

const USAGE =
  'Usage: npx tsx scripts/spikes/decisions/evaluate.ts [--model <id>] [--url <base>] [--k 3,5] [--d 5,10,15] ' +
  '[--none unmatched,basic,capped] [--cap 0.45] [--skip-a1] [--skip-score] [--skip-repeat] [--concurrency 1] [--dry-run] [--dir <dir>]'

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    url: { type: 'string' },
    k: { type: 'string', default: '3,5' },
    d: { type: 'string', default: '5,10,15' },
    none: { type: 'string', default: 'unmatched,basic,capped' },
    cap: { type: 'string', default: '0.45' },
    'skip-a1': { type: 'boolean', default: false },
    'skip-score': { type: 'boolean', default: false },
    'skip-repeat': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '1' },
    'dry-run': { type: 'boolean', default: false },
    dir: { type: 'string' },
  },
})

const list = (s: string) => s.split(',').map((x) => x.trim())
const ks = list(values.k).map(Number)
const ds = list(values.d).map(Number)
const nones = list(values.none) as NoneRule[]
const cap = Number(values.cap)
const concurrency = Number(values.concurrency)
if (
  !ks.every((k) => Number.isInteger(k) && k >= 1 && k <= 10) ||
  !ds.every((d) => Number.isFinite(d) && d >= 0) ||
  !nones.every((n) => n === 'unmatched' || n === 'basic' || n === 'capped') ||
  !(cap >= 0 && cap <= 1) ||
  !(Number.isInteger(concurrency) && concurrency >= 1)
) {
  console.error(USAGE)
  process.exit(2)
}

loadEnvFile()
const url = (values.url || process.env.SPLE_LOCAL_JUDGE_URL?.trim() || 'http://localhost:1234/v1').replace(/\/+$/, '')
const model = values.model || process.env.SPLE_LOCAL_JUDGE_MODEL?.trim() || ''
if (!/^https?:\/\//.test(url)) {
  console.error('The judge URL must be an http(s) URL.')
  process.exit(2)
}

const dir = fixtureDir(values.dir)
const fixture = loadFixture(dir)
const tracks = labelledTracks(fixture)
const skipped = fixture.tracks.length - tracks.length
if (tracks.length === 0) {
  console.error(`No fully labelled tracks in ${dir}/fixture.json. Run collect.ts and label.ts first.`)
  process.exit(2)
}
const labels: Label[][] = tracks.map((t) => t.hits.map((h) => h.label as Label))
const warning = ageWarning(fixture, dir)
if (warning) console.error(warning)
if (skipped > 0) console.error(`Skipping ${skipped} track(s) with unlabelled hits.`)

const MIN_CONFIDENCES = [0.5, 0.8]

interface Run {
  name: string
  k: string
  d: string
  none: string
  withJudge: boolean
  outcomes: RunTrack[]
  measures: Measures // at the default threshold
  settings?: JudgeSettings
}

function toRun(name: string, outcomes: RunTrack[], settings?: JudgeSettings): Run {
  return {
    name,
    k: settings ? String(settings.k) : '–',
    d: settings ? String(settings.durationToleranceMs / 1000) : '5',
    none: settings?.mode === 'choice' ? settings.none : '–',
    withJudge: settings !== undefined,
    outcomes,
    measures: measure(labels, outcomes, MIN_CONFIDENCES[0]),
    settings,
  }
}

const basic = toRun(
  'basic',
  tracks.map((t) => ({ pick: basicPick(t.source, t.hits), failed: false, requests: 0, ms: 0 }))
)

const settingsFor = (k: number, d: number, none: NoneRule, extra: Partial<JudgeSettings> = {}): JudgeSettings => ({
  mode: 'choice',
  k,
  order: 'provider',
  durationToleranceMs: d * 1000,
  cap,
  none,
  ...extra,
})

function hash(body: JudgeRequest): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

const cache = loadResponses(dir)

if (values['dry-run']) {
  // D, the cap and the "none" rule only change the combination step: one request set per K and order.
  const plans = ks.map((k) => {
    const bodies = tracks
      .map((t) => ({ t, entries: choiceShortlist(t.source, t.hits, { k, order: 'provider' }) }))
      .filter(({ entries }) => entries.length > 0)
      .map(({ t, entries }) => choiceRequest(model || '<model>', t.source, entries))
    return `local K=${k}: ${bodies.length} requests, ${bodies.filter((b) => !(hash(b) in cache)).length} not cached`
  })
  const scoreRequests = tracks.reduce((n, t) => n + scoreShortlist(t.source, t.hits, Math.max(...ks)).length, 0)
  console.log(
    [
      `${tracks.length} labelled tracks; model ${model || '(unset)'} at ${url}.`,
      ...plans,
      `local-a1: up to ${tracks.length} requests per K; local-score: up to ${scoreRequests} requests; repeat: ${tracks.length}.`,
    ].join('\n')
  )
  process.exit(0)
}

if (!model) {
  console.error('Set the model: --model <id> or SPLE_LOCAL_JUDGE_MODEL (the ID as LM Studio lists it, e.g. jevk5).')
  process.exit(2)
}

let unsaved = 0
function flush(): void {
  saveResponses(dir, cache)
  unsaved = 0
}

let warnedModel = false

/** ADR 0009 A3 §3: one POST <url>/responses, 30 s timeout, no retries. */
async function post(body: JudgeRequest) {
  const started = performance.now()
  let res: Response
  try {
    res = await fetch(`${url}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    const e = error as Error & { cause?: { code?: string; message?: string } }
    if (e.name === 'TimeoutError') throw new JudgeError('timed out after 30 s')
    throw new JudgeError(`cannot reach ${url} (${e.cause?.code ?? e.cause?.message ?? e.message})`, undefined, true)
  }
  if (!res.ok) throw new JudgeError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new JudgeError('the response is not JSON')
  }
  const parsed = parseResponse(json)
  if (!parsed) throw new JudgeError('no log-probabilities in the response')
  // LM Studio answers an unknown model ID with whatever model is loaded (spike S8).
  if (parsed.model !== model && !warnedModel) {
    warnedModel = true
    console.error(`Warning: asked for model ${model}, but ${parsed.model || 'an unnamed model'} answered.`)
  }
  return { ...parsed, ms: Math.round(performance.now() - started) }
}

function asker(fresh: boolean): Ask {
  return async (body) => {
    const key = hash(body)
    if (!fresh && cache[key]) return cache[key]
    const result = await post(body)
    // The stability repeat must not replace the responses the grid was measured on.
    if (!fresh) {
      cache[key] = result
      if (++unsaved >= 20) flush()
    }
    return result
  }
}

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i])
      }
    })
  )
  return results
}

const models = new Set<string>()

async function judgeAll(settings: JudgeSettings, fresh = false): Promise<RunTrack[]> {
  const ask = asker(fresh)
  const outcomes = await pool(tracks, (t: FixtureTrack) => judgeTrack(t.source, t.hits, settings, { model, targetService: fixture.targetService, ask }))
  return outcomes.map((o) => {
    if (o.model) models.add(o.model)
    return { pick: o.pick, failed: o.error !== undefined, requests: o.requests, ms: o.ms }
  })
}

const runs: Run[] = []
const extras: Run[] = []
let stability = ''
try {
  for (const k of ks) {
    for (const d of ds) {
      for (const none of nones) {
        const settings = settingsFor(k, d, none)
        runs.push(toRun('local', await judgeAll(settings), settings))
      }
    }
    console.error(`local K=${k}: done`)
  }

  const best = chooseBest(runs, basic.measures)
  if (best?.settings) {
    const s = best.settings
    if (!values['skip-a1']) {
      const settings = { ...s, order: 'a1' as const }
      extras.push(toRun('local-a1', await judgeAll(settings), settings))
      console.error('local-a1: done')
    }
    if (!values['skip-score']) {
      const settings = { ...s, mode: 'score' as const }
      extras.push(toRun('local-score', await judgeAll(settings), settings))
      console.error('local-score: done')
    }
    if (!values['skip-repeat']) {
      const repeat = toRun('local (repeat)', await judgeAll(s, true), s)
      extras.push(repeat)
      const changed = repeat.outcomes.filter((o, i) => o.pick?.index !== best.outcomes[i].pick?.index).length
      const drift = Math.max(0, ...repeat.outcomes.map((o, i) => Math.abs((o.pick?.confidence ?? 0) - (best.outcomes[i].pick?.confidence ?? 0))))
      stability = `**Stability (best setting, fresh requests):** ${changed} of ${tracks.length} tracks picked a different hit; the largest confidence change was ${drift.toFixed(4)}.`
      console.error('repeat: done')
    }
  }
} catch (error) {
  // judgeTrack only rethrows the errors that switch the judge off (A3 §5).
  console.error(`The local judge stopped the evaluation: ${(error as Error).message}`)
  console.error('Check that LM Studio is running with the model loaded, then rerun; responses so far are cached.')
  process.exitCode = 1
} finally {
  flush()
}
if (process.exitCode) process.exit()

const best = chooseBest(runs, basic.measures)
const all = [basic, ...runs, ...extras]
const out: string[] = []
for (const mc of MIN_CONFIDENCES) {
  out.push(`**minConfidence ${mc}** (${tracks.length} tracks; time is the mean judge latency per track)`, '', TABLE_HEADER)
  for (const r of all) out.push(row(r.name, r.k, r.d, r.none, measure(labels, r.outcomes, mc), r.withJudge))
  out.push('')
}
out.push(`**Model, settings and date:** ${[...models].join(', ') || model}, cap ${cap}, ${new Date().toISOString().slice(0, 10)}  `)
if (best?.settings) {
  const verdict = passes(best.measures, basic.measures) ? '**passes**' : '**fails**'
  out.push(
    `**Best setting:** K=${best.k}, D=${best.d} s, "none" → ${best.none}; it ${verdict} the step 6 bar (false accepts ≤ basic and correct accepts ≥ basic + 10 points at 0.5).  `
  )
}
if (stability) out.push(stability)
console.log(out.join('\n'))
