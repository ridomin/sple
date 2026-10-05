import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { CanonicalPlaylistFile, PositionedTrack } from '../../../src/core/export/format.js'
import { createPlaylistFile } from '../../../src/core/export/format.js'

export const schemaUrl = new URL('../../../schemas/canonical-playlist.v1.schema.json', import.meta.url)
export const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as Record<string, unknown>

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validate = ajv.compile(schema)

/** Validate parsed JSON against the published schema; returns readable errors. */
export function schemaErrors(data: unknown): string[] {
  if (validate(data)) return []
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
}

export const EXPORTED_AT = new Date('2026-10-02T10:00:00.000Z')

export function track(position: number, overrides: Partial<PositionedTrack> = {}): PositionedTrack {
  return {
    position,
    title: `Track ${position}`,
    artists: ['Artist A'],
    album: 'Album',
    durationMs: 180000,
    isrc: null,
    addedAt: '2026-09-01T12:34:56Z',
    refs: { spotify: `spotify:track:t${position}` },
    ...overrides,
  }
}

export function samplePlaylistFile(overrides: Partial<CanonicalPlaylistFile> = {}): CanonicalPlaylistFile {
  return {
    ...createPlaylistFile({
      generatorVersion: '0.1.0',
      exportedAt: EXPORTED_AT,
      source: { provider: 'spotify', kind: 'playlist', userId: 'user1' },
      playlist: {
        ref: 'spotify:playlist:pl1',
        id: 'pl1',
        name: 'Road trip',
        description: 'Songs for the road',
        owner: { id: 'user1', displayName: 'User One' },
        public: false,
        collaborative: false,
        url: 'https://open.spotify.com/playlist/pl1',
      },
      tracks: [track(1), track(2, { artists: ['B', 'C'], isrc: 'USRC17607839' }), track(4)],
      unsupportedItems: [{ position: 3, kind: 'local', name: 'My demo.mp3', ref: 'spotify:local:::My+demo:0' }],
    }),
    ...overrides,
  }
}
