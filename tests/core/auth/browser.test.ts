import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { openBrowser, setBrowserLauncher } from '../../../src/core/auth/browser.js'

afterEach(() => setBrowserLauncher())

test('openBrowser passes the URL to the launcher and does not warn on success', async () => {
  const opened: string[] = []
  const warnings: string[] = []
  setBrowserLauncher(async (url) => { opened.push(url) })
  await openBrowser('https://accounts.example.com/authorize?x=1', { onWarning: (m) => warnings.push(m) })
  assert.deepEqual(opened, ['https://accounts.example.com/authorize?x=1'])
  assert.deepEqual(warnings, [])
})

test('openBrowser resolves (does not throw) when the launcher rejects', async () => {
  const warnings: string[] = []
  setBrowserLauncher(async () => { throw new Error('spawn xdg-open ENOENT') })
  await assert.doesNotReject(openBrowser('https://example.com', { onWarning: (m) => warnings.push(m) }))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /could not open a browser/)
  assert.match(warnings[0], /ENOENT/)
})

test('openBrowser handles non-Error rejections', async () => {
  const warnings: string[] = []
  setBrowserLauncher(() => Promise.reject('nope'))
  await openBrowser('https://example.com', { onWarning: (m) => warnings.push(m) })
  assert.match(warnings[0], /nope/)
})
