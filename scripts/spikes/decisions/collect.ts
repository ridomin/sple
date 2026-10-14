// Spike S8, step 2: run the YouTube metadata search once per source track and save the hits.
// Usage: npx tsx scripts/spikes/decisions/collect.ts <export.json|csv>... [--max-tracks 150] [--dir <dir>] [--target youtube-music]
// Needs `sple auth login --provider youtube-music`. Each search costs 1 of the 100 daily searches;
// rerun the next day to continue, tracks already in the fixture are skipped.
import { parseArgs } from 'node:util'
import { loadConfig, loadEnvFile } from '../../../src/cli/config.js'
import { createDefaultRegistry } from '../../../src/cli/provider-registry.js'
import { CanonicalFileReader } from '../../../src/core/import/file-reader.js'
import { AuthRequiredError, QuotaExhaustedError, UsageError } from '../../../src/core/provider/errors.js'
import { ageWarning, fixtureDir, loadFixture, saveFixture } from './fixture.js'

const SERVICE_NAMES: Record<string, string> = { spotify: 'Spotify', 'youtube-music': 'YouTube Music' }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'max-tracks': { type: 'string', default: '150' },
    dir: { type: 'string' },
    // `fake` (with SPLE_ENABLE_FAKE_PROVIDER=1) exercises the script without quota.
    target: { type: 'string', default: 'youtube-music' },
  },
})
const maxTracks = Number(values['max-tracks'])
if (positionals.length === 0 || !Number.isInteger(maxTracks) || maxTracks < 1) {
  console.error('Usage: npx tsx scripts/spikes/decisions/collect.ts <export.json|csv>... [--max-tracks 150] [--dir <dir>] [--target youtube-music]')
  process.exit(2)
}

const dir = fixtureDir(values.dir)
const fixture = loadFixture(dir)
const known = new Set(fixture.tracks.map((t) => t.key))

loadEnvFile()
const registry = createDefaultRegistry({ enableFake: process.env.SPLE_ENABLE_FAKE_PROVIDER === '1' })
let provider
try {
  provider = registry.create(values.target, loadConfig({ provider: values.target }, process.env, registry.list()))
} catch (error) {
  if (!(error instanceof UsageError)) throw error
  console.error(error.message)
  process.exit(2)
}
fixture.targetService = provider.displayName
const reader = new CanonicalFileReader({ trackRefParsers: registry.trackRefParsers(), onWarning: (m) => console.error(m) })

let searched = 0
try {
  outer: for (const path of positionals) {
    const file = await reader.readFile(path)
    const sourceProvider = file.source.provider
    for (const track of file.tracks) {
      if (fixture.tracks.length >= maxTracks) break outer
      if (!track.title) continue
      const key = track.refs[sourceProvider] ?? `${sourceProvider}:${track.title}|${track.artists.join(',')}`
      if (known.has(key)) continue

      const hits = await provider.searchTracks(
        { kind: 'metadata', title: track.title, artists: track.artists, album: track.album, durationMs: track.durationMs },
        { limit: 10 }
      )
      if (fixture.tracks.length === 0) fixture.createdAt = new Date().toISOString()
      fixture.tracks.push({
        key,
        source: {
          service: SERVICE_NAMES[sourceProvider] ?? sourceProvider,
          title: track.title,
          artists: track.artists,
          ...(track.album ? { album: track.album } : {}),
          ...(typeof track.durationMs === 'number' ? { durationMs: track.durationMs } : {}),
        },
        searchedAt: new Date().toISOString(),
        hits: hits.map((h) => ({
          ref: h.ref,
          title: h.track.title,
          artists: h.track.artists,
          ...(h.track.album ? { album: h.track.album } : {}),
          ...(typeof h.track.durationMs === 'number' ? { durationMs: h.track.durationMs } : {}),
        })),
      })
      known.add(key)
      saveFixture(dir, fixture)
      searched++
      console.error(`[${fixture.tracks.length}/${maxTracks}] ${hits.length} hits`)
    }
  }
} catch (error) {
  if (error instanceof QuotaExhaustedError) {
    const when = error.resetAt ? ` after ${error.resetAt.toISOString()}` : ' tomorrow'
    console.error(`YouTube search quota used up. Rerun${when} to continue.`)
  } else if (error instanceof AuthRequiredError) {
    console.error(`${error.message}\nRun: sple auth login --provider youtube-music`)
    process.exitCode = 1
  } else {
    throw error
  }
}

console.error(`Searched ${searched} track(s) this run; the fixture has ${fixture.tracks.length}: ${dir}/fixture.json`)
const warning = ageWarning(fixture, dir)
if (warning) console.error(warning)
