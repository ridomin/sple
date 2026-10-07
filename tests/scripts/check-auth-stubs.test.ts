import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findStubs, isAuthFile } from '../../scripts/check-auth-stubs.js'

test('isAuthFile covers core auth, provider auth.ts and scopes.ts only', () => {
  assert.ok(isAuthFile('src/core/auth/oauth-handler.ts'))
  assert.ok(isAuthFile('src/providers/youtube-music/auth.ts'))
  assert.ok(isAuthFile('src/providers/spotify/scopes.ts'))
  assert.ok(!isAuthFile('src/providers/youtube-music/index.ts'))
  assert.ok(!isAuthFile('src/cli/commands/auth/login.ts'))
})

test('findStubs flags TODO/FIXME/XXX markers and silenced arguments', () => {
  const src = [
    'async requireScopes(scopes: string[]) {',
    '  // TODO: Check if token has required scopes',
    '  void scopes',
    '  // FIXME later',
    '  // XXX hack',
    '  return token',
    '}',
  ].join('\n')

  assert.deepStrictEqual(
    findStubs(src).map((s) => s.line),
    [2, 3, 4, 5]
  )
})

test('findStubs ignores void expressions and words that merely contain the markers', () => {
  const src = [
    'void this.refresh()',
    'void promise.then(() => {})',
    'const todoList = []',
    'function f(): void {}',
  ].join('\n')

  assert.deepStrictEqual(findStubs(src), [])
})

test('the repository has no stubs in auth code', async () => {
  const { scanRepo } = await import('../../scripts/check-auth-stubs.js')
  assert.deepStrictEqual(scanRepo(), [])
})
