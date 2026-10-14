// Spike S8, steps 4–6: run `basic` and the `openai` judge offline against the labelled fixture.
// Usage: npx tsx scripts/spikes/decisions/evaluate.ts [--k 3,5,8] [--d 5,10,15] [--cap 0.45] [--gate relaxed|none]
//          [--skip-pair] [--skip-repeat] [--concurrency 4] [--dry-run] [--dir <dir>]
// Needs OPENAI_API_KEY (environment or <configDir>/.env) unless --dry-run. Responses are cached in
// <dir>/responses.json, so rerunning the grid costs nothing; the stability repeat always calls the API.
// Prints counts and rates only (Markdown), ready to paste into docs/spikes/decisions-matching-spike.md.
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import OpenAI from 'openai'
import { loadEnvFile } from '../../../src/cli/config.js'
import { ageWarning, fixtureDir, labelledTracks, loadFixture, loadResponses, saveResponses, type FixtureTrack } from './fixture.js'
import { basicPick, buildRequest, judgeTrack, shortlist, type Answer, type Ask, type JudgeSettings, type TrackOutcome } from './judge.js'
import { chooseBest, measure, passes, row, TABLE_HEADER, type Label, type Measures, type RunTrack } from './metrics.js'

const USAGE =
  'Usage: npx tsx scripts/spikes/decisions/evaluate.ts [--k 3,5,8] [--d 5,10,15] [--cap 0.45] [--gate relaxed|none] ' +
  '[--skip-pair] [--skip-repeat] [--concurrency 4] [--dry-run] [--dir <dir>]'

const { values } = parseArgs({
  options: {
    k: { type: 'string', default: '3,5,8' },
    d: { type: 'string', default: '5,10,15' },
    cap: { type: 'string', default: '0.45' },
    gate: { type: 'string', default: 'relaxed' },
    'skip-pair': { type: 'boolean', default: false },
    'skip-repeat': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    'dry-run': { type: 'boolean', default: false },
    dir: { type: 'string' },
  },
})

function numbers(s: string): number[] {
  return s.split(',').map((x) => Number(x.trim()))
}
const ks = numbers(values.k)
const ds = numbers(values.d)
const cap = Number(values.cap)
const concurrency = Number(values.concurrency)
const gate = values.gate
if (
  !ks.every((k) => Number.isInteger(k) && k >= 1 && k <= 10) ||
  !ds.every((d) => Number.isFinite(d) && d >= 0) ||
  !(cap >= 0 && cap <= 1) ||
  !(Number.isInteger(concurrency) && concurrency >= 1) ||
  (gate !== 'relaxed' && gate !== 'none')
) {
  console.error(USAGE)
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
  withJudge: boolean
  outcomes: RunTrack[]
  measures: Measures // at the default threshold
  settings?: JudgeSettings
  picks?: Array<number | null>
}

function toRun(name: string, k: string, d: string, outcomes: RunTrack[], withJudge: boolean, extra: Partial<Run> = {}): Run {
  return { name, k, d, withJudge, outcomes, measures: measure(labels, outcomes, MIN_CONFIDENCES[0]), ...extra }
}

const basic = toRun(
  'basic',
  '–',
  '5',
  tracks.map((t) => ({ pick: basicPick(t.source, t.hits), refusal: false, failed: false, requests: 0, inputTokens: 0, ms: 0 })),
  false
)

const settingsFor = (k: number, d: number, pair = false): JudgeSettings => ({
  k,
  durationToleranceMs: d * 1000,
  cap,
  gate: gate as JudgeSettings['gate'],
  pair,
})

loadEnvFile()
const model = process.env.SPLE_OPENAI_DECISIONS_MODEL?.trim() || 'gpt-6-luna'

if (values['dry-run']) {
  // D only changes the combination step, so the grid needs one request set per K.
  const cache = loadResponses(dir)
  const plans = ks.map((k) => {
    const bodies = tracks
      .map((t) => ({ t, list: shortlist(t.source, t.hits, settingsFor(k, 0)) }))
      .filter(({ list }) => list.length > 0)
      .map(({ t, list }) => buildRequest(model, t.source, fixture.targetService, list))
    const uncached = bodies.filter((b) => !(hash(b) in cache))
    const chars = uncached.reduce((n, b) => n + JSON.stringify(b).length, 0)
    return `K=${k}: ${bodies.length} requests, ${uncached.length} not cached, about ${Math.round(chars / 4)} input tokens`
  })
  console.log([`${tracks.length} labelled tracks; model ${model}.`, ...plans].join('\n'))
  process.exit(0)
}

function hash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

const apiKey = process.env.OPENAI_API_KEY?.trim()
if (!apiKey) {
  console.error('Set OPENAI_API_KEY in the environment or in the sple .env file.')
  process.exit(2)
}

// ADR 0011 §6: sple's explicit SDK settings.
const client = new OpenAI({ apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 2, timeout: 30_000, logLevel: 'warn' })
const cache = loadResponses(dir)
let unsaved = 0

function asker(fresh: boolean): Ask {
  return async (body) => {
    const key = hash(body)
    if (!fresh && cache[key]) return cache[key]
    const started = performance.now()
    const response = await client.decisions.create(body)
    const result = {
      answers: response.answers as Answer[],
      model: response.model,
      inputTokens: response.usage.input_tokens,
      ms: Math.round(performance.now() - started),
    }
    // The stability repeat must not replace the responses the grid was measured on.
    if (!fresh) {
      cache[key] = result
      if (++unsaved >= 20) flush()
    }
    return result
  }
}

function flush(): void {
  saveResponses(dir, cache)
  unsaved = 0
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
  const outcomes = await pool(tracks, (t: FixtureTrack) =>
    judgeTrack(t.source, t.hits, settings, { model, targetService: fixture.targetService, ask })
  )
  return outcomes.map((o: TrackOutcome) => {
    if (o.model) models.add(o.model)
    return { pick: o.pick, refusal: o.refusal, failed: o.error !== undefined && !o.refusal, requests: o.requests, inputTokens: o.inputTokens, ms: o.ms }
  })
}

const runs: Run[] = []
const extras: Run[] = []
let stability = ''
try {
  for (const k of ks) {
    for (const d of ds) {
      const settings = settingsFor(k, d)
      const outcomes = await judgeAll(settings)
      runs.push(toRun('openai', String(k), String(d), outcomes, true, { settings }))
      console.error(`openai K=${k} D=${d}: done`)
    }
  }

  const best = chooseBest(runs, basic.measures)
  if (best?.settings) {
    const { k, durationToleranceMs } = best.settings
    const d = durationToleranceMs / 1000
    if (!values['skip-pair']) {
      extras.push(toRun('openai-pair', String(k), String(d), await judgeAll(settingsFor(k, d, true)), true))
      console.error('openai-pair: done')
    }
    if (!values['skip-repeat']) {
      const repeat = toRun('openai (repeat)', String(k), String(d), await judgeAll(best.settings, true), true)
      extras.push(repeat)
      const changed = repeat.outcomes.filter((o, i) => o.pick?.index !== best.outcomes[i].pick?.index).length
      const flipped = repeat.outcomes.filter(
        (o, i) => (o.pick?.confidence ?? 0) >= 0.5 !== (best.outcomes[i].pick?.confidence ?? 0) >= 0.5
      ).length
      stability = `**Stability (K=${k}, D=${d}, fresh requests):** ${changed} of ${tracks.length} tracks picked a different hit; ${flipped} crossed the 0.5 threshold.`
      console.error('repeat: done')
    }
  }
} catch (error) {
  // judgeTrack only rethrows the errors that would switch OpenAI off (A3 §5).
  const status = (error as { status?: number }).status
  console.error(`OpenAI stopped the evaluation (HTTP ${status}): ${(error as Error).message}`)
  console.error('Fix the API key, model access or credit and rerun; responses so far are cached.')
  process.exitCode = 1
} finally {
  flush()
}
if (process.exitCode) process.exit()

const best = chooseBest(runs, basic.measures)
const all = [basic, ...runs, ...extras]
const out: string[] = []
for (const mc of MIN_CONFIDENCES) {
  out.push(`**minConfidence ${mc}** (${tracks.length} tracks; tokens are input tokens, time is the sum of request latencies)`, '', TABLE_HEADER)
  for (const r of all) out.push(row(r.name, r.k, r.d, measure(labels, r.outcomes, mc), r.withJudge))
  out.push('')
}
out.push(`**Model and date:** ${[...models].join(', ') || model} · ${new Date().toISOString().slice(0, 10)}  `)
out.push(`**Settings:** cap ${cap}, gate \`${gate === 'relaxed' ? 't > 0 || a > 0' : 'none'}\`  `)
if (best?.settings) {
  const verdict = passes(best.measures, basic.measures) ? '**passes**' : '**fails**'
  out.push(`**Best setting:** K=${best.k}, D=${best.d} s; it ${verdict} the step 6 bar (false accepts ≤ basic and correct accepts ≥ basic + 10 points at 0.5).  `)
}
if (stability) out.push(stability)
console.log(out.join('\n'))
