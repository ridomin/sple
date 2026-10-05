import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProgress } from '../../src/cli/progress.js'

function stream(isTTY = true) {
  const writes: string[] = []
  return { writes, s: { isTTY, write: (c: string) => writes.push(c) } }
}

test('createProgress', async (t) => {
  await t.test('draws a bar when the total is known and clears on done', () => {
    const { writes, s } = stream()
    const p = createProgress('Exporting "Road trip"', 'tracks', { enabled: true, stream: s, now: () => 0 })
    p.update(600, 1000)
    p.done()
    assert.deepEqual(writes, ['\r\x1b[KExporting "Road trip" [######----] 600/1000 tracks', '\r\x1b[K'])
  })

  await t.test('draws a spinner and count when the total is unknown', () => {
    const { writes, s } = stream()
    let t0 = 0
    const p = createProgress('Fetching', 'pages', { enabled: true, stream: s, now: () => (t0 += 200) })
    p.update(1)
    p.update(2)
    assert.deepEqual(writes, ['\r\x1b[KFetching | 1 pages', '\r\x1b[KFetching / 2 pages'])
  })

  await t.test('redraws at most 10 times per second, but always draws the final update', () => {
    const { writes, s } = stream()
    const p = createProgress('L', 'x', { enabled: true, stream: s, now: () => 50 })
    p.update(1, 10)
    p.update(2, 10)
    p.update(3, 10)
    p.update(10, 10)
    assert.equal(writes.length, 2)
    assert.match(writes[1], /10\/10/)
  })

  await t.test('is a no-op when disabled or the stream is not a TTY', () => {
    for (const [enabled, tty] of [[false, true], [true, false]] as const) {
      const { writes, s } = stream(tty)
      const p = createProgress('L', 'x', { enabled, stream: s })
      p.update(1, 2)
      p.done()
      assert.deepEqual(writes, [])
    }
  })

  await t.test('done without a drawn line writes nothing', () => {
    const { writes, s } = stream()
    createProgress('L', 'x', { enabled: true, stream: s }).done()
    assert.deepEqual(writes, [])
  })
})
