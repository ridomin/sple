// Spike S8: the local fixture (protocol steps 2–3) and the Decisions response cache.
// Both live outside the repo, under <configDir>/spikes/s8/, and are deleted within
// 30 days of collection (YouTube API Developer Policies III.E.4).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../../../src/core/config/paths.js'
import type { AskResult, Hit, SourceTrack } from './judge.js'
import type { Label } from './metrics.js'

export interface FixtureTrack {
  /** The source ref (or `<provider>:<title>|<artists>` without one), unique in the fixture. */
  key: string
  source: SourceTrack
  searchedAt: string
  hits: Array<Hit & { label?: Label }>
}

export interface Fixture {
  version: 1
  /** When the first YouTube hit was saved; the 30-day clock starts here. */
  createdAt: string
  targetService: string
  tracks: FixtureTrack[]
}

const MAX_AGE_DAYS = 30
const DAY_MS = 86_400_000

export function fixtureDir(dir?: string): string {
  return dir ?? join(getConfigDir(), 'spikes', 's8')
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
}

/** Write via a temp file so an interrupted run never leaves half a file. */
function writeJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function loadFixture(dir: string): Fixture {
  return readJson<Fixture>(join(dir, 'fixture.json'), {
    version: 1,
    createdAt: new Date().toISOString(),
    targetService: 'YouTube Music',
    tracks: [],
  })
}

export function saveFixture(dir: string, fixture: Fixture): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeJson(join(dir, 'fixture.json'), fixture)
}

/** A reminder line once the fixture is 25 days old, or null. */
export function ageWarning(fixture: Fixture, dir: string, now = Date.now()): string | null {
  if (fixture.tracks.length === 0) return null
  const created = Date.parse(fixture.createdAt)
  const age = Math.floor((now - created) / DAY_MS)
  if (age < MAX_AGE_DAYS - 5) return null
  const deadline = new Date(created + MAX_AGE_DAYS * DAY_MS).toISOString().slice(0, 10)
  return age >= MAX_AGE_DAYS
    ? `The fixture is ${age} days old. Delete it now (YouTube III.E.4): rm -rf "${dir}"`
    : `The fixture is ${age} days old. Delete it by ${deadline} (YouTube III.E.4): rm -rf "${dir}"`
}

/** Tracks whose hits are all labelled; only these are evaluated. */
export function labelledTracks(fixture: Fixture): FixtureTrack[] {
  return fixture.tracks.filter((t) => t.hits.every((h) => h.label !== undefined))
}

/** Decisions responses keyed by a hash of the request body. Answers carry candidate keys only, no titles. */
export type ResponseCache = Record<string, AskResult>

export function loadResponses(dir: string): ResponseCache {
  return readJson<ResponseCache>(join(dir, 'responses.json'), {})
}

export function saveResponses(dir: string, cache: ResponseCache): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeJson(join(dir, 'responses.json'), cache)
}
