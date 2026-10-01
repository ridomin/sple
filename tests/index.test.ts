import { test } from 'node:test'
import * as assert from 'node:assert'
import { version } from '../src/index'

test('sple exports a version', () => {
  assert.ok(version)
  assert.strictEqual(typeof version, 'string')
  assert.match(version, /^\d+\.\d+\.\d+/)
})
