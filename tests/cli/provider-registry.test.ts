import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultRegistry } from '../../src/cli/provider-registry.js'
import { loadConfig } from '../../src/cli/config.js'
import { UsageError } from '../../src/core/provider/errors.js'

test('registry: spotify without client ID throws UsageError', () => {
  const config = loadConfig({ provider: 'spotify' }, {})
  assert.throws(() => createDefaultRegistry().create('spotify', config), UsageError)
})

test('registry: youtube-music without client ID throws UsageError', () => {
  const config = loadConfig({ provider: 'youtube-music' }, { SPLE_YOUTUBE_MUSIC_CLIENT_ID: '  ' })
  assert.throws(() => createDefaultRegistry().create('youtube-music', config), UsageError)
})

test('registry: providers are built from config at create time', () => {
  const config = loadConfig(
    {},
    { SPLE_SPOTIFY_CLIENT_ID: 'sid', SPLE_YOUTUBE_MUSIC_CLIENT_ID: 'yid', SPLE_GOOGLE_CLIENT_SECRET: 's' }
  )
  const registry = createDefaultRegistry()
  assert.equal(registry.create('spotify', config).id, 'spotify')
  assert.equal(registry.create('youtube-music', config).id, 'youtube-music')
})
