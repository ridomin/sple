// Spike S8, step 3: hand-label every (track, hit) pair as same, version or different.
// Usage: npx tsx scripts/spikes/decisions/label.ts [--relabel] [--dir <dir>]
// Keys: s same · v version · d different · D this and the rest of the track different · b back · q quit.
// Every key press is saved, so quitting and rerunning picks up where you stopped.
import { emitKeypressEvents } from 'node:readline'
import { parseArgs } from 'node:util'
import { ageWarning, fixtureDir, loadFixture, saveFixture } from './fixture.js'
import type { Label } from './metrics.js'

const { values } = parseArgs({ options: { relabel: { type: 'boolean', default: false }, dir: { type: 'string' } } })
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

const isOpen = ([ti, hi]: readonly [number, number]) => values.relabel || fixture.tracks[ti].hits[hi].label === undefined
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

function render(): void {
  const [ti, hi] = pairs[at]
  const track = fixture.tracks[ti]
  const done = fixture.tracks.reduce((n, t) => n + t.hits.filter((h) => h.label).length, 0)
  const out = [
    `\x1b[2J\x1b[HTrack ${ti + 1}/${fixture.tracks.length} · hit ${hi + 1}/${track.hits.length} · labelled ${done}/${total}`,
    '',
    `Source  ${line(track.source)}`,
    '',
    ...track.hits.map((h, i) => {
      const delta = typeof h.durationMs === 'number' && typeof track.source.durationMs === 'number'
        ? ` (Δ ${Math.round((h.durationMs - track.source.durationMs) / 1000)} s)`
        : ''
      const row = `${i === hi ? '▶' : ' '} ${h.label ? MARK[h.label] : ' '} ${i + 1}. ${line(h)}${delta}`
      return i === hi ? `\x1b[1m${row}\x1b[0m` : row
    }),
    '',
    '[s]ame recording  [v]ersion (live, cover, remix…)  [d]ifferent song  [D] rest different  [b]ack  [q]uit',
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

function advance(): void {
  history.push(at)
  const next = pairs.findIndex((p, i) => i > at && isOpen(p))
  if (next < 0) finish(`Done: all ${total} pairs labelled.`)
  at = next
}

if (at < 0) finish(`All ${total} pairs are labelled. Use --relabel to go through them again.`)

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
  } else if (str === 'D') {
    for (let i = hi; i < hits.length; i++) if (values.relabel || i === hi || !hits[i].label) hits[i].label = 'different'
    saveFixture(dir, fixture)
    history.push(at)
    const next = pairs.findIndex((p, i) => i > at && p[0] !== ti && isOpen(p))
    if (next < 0) finish(`Done: all ${total} pairs labelled.`)
    at = next
  } else if (str && KEYS[str]) {
    hits[hi].label = KEYS[str]
    saveFixture(dir, fixture)
    advance()
  }
  render()
})
