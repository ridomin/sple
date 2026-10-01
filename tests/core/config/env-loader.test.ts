import { test } from 'node:test'
import * as assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadEnv, mergeEnv, loadAndMergeEnv } from '../../../src/core/config/env-loader.js'

test('env loader', async (t) => {
  let tempDir: string

  await t.before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sple-test-'))
  })

  await t.after(() => {
    rmSync(tempDir, { recursive: true })
  })

  await t.test('loadEnv', async (t) => {
    await t.test('parses basic KEY=VALUE pairs', () => {
      const envContent = `SPLE_SPOTIFY_CLIENT_ID=abc123
SPLE_DEFAULT_PROVIDER=spotify`
      writeFileSync(join(tempDir, '.env'), envContent)

      const result = loadEnv(tempDir)
      assert.strictEqual(result.SPLE_SPOTIFY_CLIENT_ID, 'abc123')
      assert.strictEqual(result.SPLE_DEFAULT_PROVIDER, 'spotify')
    })

    await t.test('ignores comments', () => {
      const envContent = `# This is a comment
SPLE_KEY=value
# Another comment
SPLE_KEY2=value2`
      writeFileSync(join(tempDir, '.env'), envContent)

      const result = loadEnv(tempDir)
      assert.strictEqual(result.SPLE_KEY, 'value')
      assert.strictEqual(result.SPLE_KEY2, 'value2')
      assert.ok(!('# This is a comment' in result))
    })

    await t.test('ignores empty lines', () => {
      const envContent = `SPLE_KEY=value

SPLE_KEY2=value2

`
      writeFileSync(join(tempDir, '.env'), envContent)

      const result = loadEnv(tempDir)
      assert.strictEqual(result.SPLE_KEY, 'value')
      assert.strictEqual(result.SPLE_KEY2, 'value2')
      assert.strictEqual(Object.keys(result).length, 2)
    })

    await t.test('handles values with spaces', () => {
      const envContent = `SPLE_DESC=This is a description`
      writeFileSync(join(tempDir, '.env'), envContent)

      const result = loadEnv(tempDir)
      assert.strictEqual(result.SPLE_DESC, 'This is a description')
    })

    await t.test('does not override process.env', () => {
      process.env.TEST_VAR = 'original'
      const envContent = `TEST_VAR=new_value`
      writeFileSync(join(tempDir, '.env'), envContent)

      const result = loadEnv(tempDir)
      assert.strictEqual(result.TEST_VAR, undefined)
      assert.strictEqual(process.env.TEST_VAR, 'original')

      delete process.env.TEST_VAR
    })

    await t.test('returns empty object if file does not exist', () => {
      const result = loadEnv(join(tempDir, 'nonexistent'))
      assert.deepStrictEqual(result, {})
    })

    await t.test('handles empty .env file', () => {
      writeFileSync(join(tempDir, '.env'), '')

      const result = loadEnv(tempDir)
      assert.deepStrictEqual(result, {})
    })

    await t.test('handles lines with only whitespace', () => {
      const envContent = `SPLE_KEY=value

\t
SPLE_KEY2=value2`
      writeFileSync(join(tempDir, '.env'), envContent)

      const result = loadEnv(tempDir)
      assert.strictEqual(result.SPLE_KEY, 'value')
      assert.strictEqual(result.SPLE_KEY2, 'value2')
    })

    await t.test('handles keys with special characters', () => {
      const envContent = `SPLE_SPOTIFY_CLIENT_ID=abc123
SPLE_YOUTUBE_MUSIC_CLIENT_ID=xyz789`
      writeFileSync(join(tempDir, '.env'), envContent)

      const result = loadEnv(tempDir)
      assert.strictEqual(result.SPLE_SPOTIFY_CLIENT_ID, 'abc123')
      assert.strictEqual(result.SPLE_YOUTUBE_MUSIC_CLIENT_ID, 'xyz789')
    })
  })

  await t.test('mergeEnv', async (t) => {
    await t.test('adds variables to process.env', () => {
      const envVars = { TEST_MERGE_KEY: 'test_value' }
      mergeEnv(envVars)

      assert.strictEqual(process.env.TEST_MERGE_KEY, 'test_value')

      delete process.env.TEST_MERGE_KEY
    })

    await t.test('does not override existing process.env variables', () => {
      process.env.EXISTING_VAR = 'original'
      const envVars = { EXISTING_VAR: 'new_value', NEW_VAR: 'added' }
      mergeEnv(envVars)

      assert.strictEqual(process.env.EXISTING_VAR, 'original')
      assert.strictEqual(process.env.NEW_VAR, 'added')

      delete process.env.EXISTING_VAR
      delete process.env.NEW_VAR
    })
  })

  await t.test('loadAndMergeEnv', async (t) => {
    await t.test('loads and merges in one call', () => {
      const envContent = `SPLE_COMBINED_TEST=works`
      writeFileSync(join(tempDir, '.env'), envContent)

      const result = loadAndMergeEnv(tempDir)
      assert.strictEqual(result.SPLE_COMBINED_TEST, 'works')
      assert.strictEqual(process.env.SPLE_COMBINED_TEST, 'works')

      delete process.env.SPLE_COMBINED_TEST
    })
  })
})
