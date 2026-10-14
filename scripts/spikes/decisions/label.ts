// Spike S8, step 3: hand-label every (track, hit) pair as same, version or different.
// Usage: npx tsx scripts/spikes/decisions/label.ts [--relabel | --review] [--dir <dir>]
// Keys: s same · v version · d different · D this AND every later result of the track different · b back · q quit.
// --review walks the results whose proposed label (a `proposed` field in the fixture) differs from yours:
//   Enter accepts the proposal · s/v/d sets your own · A accepts every remaining proposal of the track.
// Every key press is saved, so quitting and rerunning picks up where you stopped.
import { emitKeypressEvents } from 'node:readline'
import { parseArgs } from 'node:util'
import { ageWarning, fixtureDir, loadFixture, saveFixture } from './fixture.js'
import type { Label } from './metrics.js'

const { values } = parseArgs({
  options: { relabel: { type: 'boolean', default: false }, review: { type: 'boolean', default: false }, dir: { type: 'string' } },
})
if (!process.stdin.isTTY) {
  console.error('label.ts needs an interactive terminal.')
  process.exit(2)
}

const dir = fixtureDir(values.dir)
const fixture = loadFixture(dir)
const pairs = fixture.tracks.flatMap((t, ti) => t.hits.map((_, hi) => [ti, hi] as const))
const total = pairs.length
if (total === 0) {
  console.error(`No hits in ${dir}/fixture.json. Run collect.ts first.`)
  process.exit(2)
}

const isOpen = ([ti, hi]: readonly [number, number]) => {
  const h = fixture.tracks[ti].hits[hi]
  if (values.review) return h.proposed !== undefined && !h.reviewed && h.proposed !== h.label
  return values.relabel || h.label === undefined
}
const pending = fixture.tracks.reduce((n, t, ti) => n + t.hits.filter((_, hi) => isOpen([ti, hi])).length, 0)
let at = pairs.findIndex(isOpen)
const history: number[] = []

function mmss(ms?: number): string {
  if (typeof ms !== 'number') return '–:––'
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function line(t: { title: string; artists: string[]; album?: string; durationMs?: number }): string {
  return `${t.title} — ${t.artists.join(', ') || '?'}${t.album ? ` · ${t.album}` : ''} · ${mmss(t.durationMs)}`
}

const MARK: Record<Label, string> = { same: 'S', version: 'v', different: '·' }

function marks(h: { label?: Label; proposed?: Label; reviewed?: boolean }): string {
  const own = h.label ? MARK[h.label] : ' '
  if (!values.review || h.proposed === undefined) return own
  if (h.reviewed || h.proposed === h.label) return `${own}  `
  return `${own}→${MARK[h.proposed]}`
}

function render(): void {
  const [ti, hi] = pairs[at]
  const track = fixture.tracks[ti]
  const done = values.review
    ? pending - fixture.tracks.reduce((n, t, i) => n + t.hits.filter((_, j) => isOpen([i, j])).length, 0)
    : fixture.tracks.reduce((n, t) => n + t.hits.filter((h) => h.label).length, 0)
  const progress = values.review ? `reviewed ${done}/${pending}` : `labelled ${done}/${total}`
  const out = [
    `\x1b[2J\x1b[HTrack ${ti + 1}/${fixture.tracks.length} · hit ${hi + 1}/${track.hits.length} · ${progress}`,
    '',
    `Source  ${line(track.source)}`,
    '',
    ...track.hits.map((h, i) => {
      const delta = typeof h.durationMs === 'number' && typeof track.source.durationMs === 'number'
        ? ` (Δ ${Math.round((h.durationMs - track.source.durationMs) / 1000)} s)`
        : ''
      const row = `${i === hi ? '▶' : ' '} ${marks(h)} ${i + 1}. ${line(h)}${delta}`
      return i === hi ? `\x1b[1m${row}\x1b[0m` : row
    }),
    '',
    values.review
      ? 'yours→proposed (S same · v version · · different)   [Enter] accept proposal  [s]/[v]/[d] your label  [A] accept the rest of this track  [b]ack  [q]uit'
      : '[s]ame recording  [v]ersion (live, cover, remix…)  [d]ifferent song  [D] this and ALL later results different  [b]ack  [q]uit',
  ]
  process.stdout.write(out.join('\n') + '\n')
}

function finish(message: string): never {
  process.stdin.setRawMode(false)
  saveFixture(dir, fixture)
  console.log(message)
  const warning = ageWarning(fixture, dir)
  if (warning) console.log(warning)
  process.exit(0)
}

const DONE = values.review ? 'Done: every proposal is reviewed.' : `Done: all ${total} pairs labelled.`

function advance(): void {
  history.push(at)
  const next = pairs.findIndex((p, i) => i > at && isOpen(p))
  if (next < 0) finish(DONE)
  at = next
}

if (at < 0) {
  finish(values.review ? 'Nothing to review.' : `All ${total} pairs are labelled. Use --relabel to go through them again.`)
}

const KEYS: Record<string, Label> = { s: 'same', v: 'version', d: 'different' }
emitKeypressEvents(process.stdin)
process.stdin.setRawMode(true)
render()
process.stdin.on('keypress', (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
  if (key.ctrl && key.name === 'c') finish('Saved.')
  const [ti, hi] = pairs[at]
  const hits = fixture.tracks[ti].hits
  if (str === 'q') finish('Saved.')
  else if (str === 'b') {
    if (history.length > 0) at = history.pop() as number
  } else if (values.review && key.name === 'return') {
    hits[hi].label = hits[hi].proposed
    hits[hi].reviewed = true
    saveFixture(dir, fixture)
    advance()
  } else if (values.review && str === 'A') {
    hits.forEach((h, i) => {
      if (isOpen([ti, i])) {
        h.label = h.proposed
        h.reviewed = true
      }
    })
    saveFixture(dir, fixture)
    history.push(at)
    const next = pairs.findIndex((p, i) => i > at && isOpen(p))
    if (next < 0) finish(DONE)
    at = next
  } else if (!values.review && str === 'D') {
    for (let i = hi; i < hits.length; i++) if (values.relabel || i === hi || !hits[i].label) hits[i].label = 'different'
    saveFixture(dir, fixture)
    history.push(at)
    const next = pairs.findIndex((p, i) => i > at && p[0] !== ti && isOpen(p))
    if (next < 0) finish(DONE)
    at = next
  } else if (str && KEYS[str]) {
    hits[hi].label = KEYS[str]
    if (values.review) hits[hi].reviewed = true
    saveFixture(dir, fixture)
    advance()
  }
  render()
})
