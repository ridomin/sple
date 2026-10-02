import { test } from 'node:test'
import * as assert from 'node:assert'
import { emit, type OutputContent } from '../../src/cli/output.js'
import type { CommandContext } from '../../src/cli/cli.js'
import type { SearchOutput } from '../../src/cli/output/types.js'

function createMockContext(overrides?: Partial<CommandContext>): CommandContext {
  const out: string[] = []
  const err: string[] = []
  return {
    registry: null as any,
    config: { provider: 'spotify', verbose: false, spotifyClientId: 'test' },
    io: {
      out: (m) => out.push(m),
      err: (m) => err.push(m),
    },
    version: '1.0.0',
    json: false,
    quiet: false,
    debug: false,
    ...overrides,
  }
}

test('emit JSON output with --json flag', () => {
  const out: string[] = []
  const ctx = createMockContext({ json: true, io: { out: (m) => out.push(m), err: () => {} } })

  const content: SearchOutput = {
    items: [
      {
        id: '123',
        ref: 'spotify:track:123',
        type: 'track',
        name: 'Test Track',
        track: {
          title: 'Test Track',
          artists: ['Artist 1'],
          album: 'Test Album',
          durationMs: 180000,
          refs: { spotify: 'spotify:track:123' },
        },
      },
    ],
  }

  emit(ctx, { json: content })

  assert.strictEqual(out.length, 1)
  const parsed = JSON.parse(out[0])
  assert.ok(parsed.items)
  assert.strictEqual(parsed.items.length, 1)
  assert.strictEqual(parsed.items[0].id, '123')
})

test('emit quiet output with --quiet flag', () => {
  const out: string[] = []
  const ctx = createMockContext({ quiet: true, io: { out: (m) => out.push(m), err: () => {} } })

  emit(ctx, { quiet: ['id1', 'id2', 'id3'] })

  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0], 'id1\nid2\nid3')
})

test('emit quiet mode returns empty for empty IDs', () => {
  const out: string[] = []
  const ctx = createMockContext({ quiet: true, io: { out: (m) => out.push(m), err: () => {} } })

  emit(ctx, { quiet: [] })

  assert.strictEqual(out.length, 0)
})

test('emit table output when TTY', () => {
  const out: string[] = []
  const ctx = createMockContext({ io: { out: (m) => out.push(m), err: () => {} } })

  // Mock TTY
  const originalIsTTY = process.stdout.isTTY
  const originalColumns = process.stdout.columns
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true })

  try {
    emit(ctx, {
      table: [
        { title: 'Song 1', artists: 'Artist 1', duration: 180 },
        { title: 'Song 2', artists: 'Artist 2', duration: 240 },
      ],
      columns: [
        { name: 'title', width: 30 },
        { name: 'artists', width: 30 },
        { name: 'duration', width: 10 },
      ],
    })

    assert.strictEqual(out.length, 1)
    const lines = out[0].split('\n')
    assert.ok(lines.length >= 3) // header + separator + at least 2 data rows
    assert.match(lines[0], /title/)
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
  }
})

test('emit tab-separated output when not TTY', () => {
  const out: string[] = []
  const ctx = createMockContext({ io: { out: (m) => out.push(m), err: () => {} } })

  // Mock non-TTY
  const originalIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })

  try {
    emit(ctx, {
      table: [
        { title: 'Song 1', artists: 'Artist 1', duration: 180 },
        { title: 'Song 2', artists: 'Artist 2', duration: 240 },
      ],
      columns: [
        { name: 'title' },
        { name: 'artists' },
        { name: 'duration' },
      ],
    })

    assert.strictEqual(out.length, 1)
    const lines = out[0].split('\n')
    assert.strictEqual(lines.length, 2) // No header in TSV mode
    assert.match(lines[0], /Song 1\tArtist 1\t180/)
    assert.match(lines[1], /Song 2\tArtist 2\t240/)
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
  }
})

test('emit empty table returns empty', () => {
  const out: string[] = []
  const ctx = createMockContext({ io: { out: (m) => out.push(m), err: () => {} } })

  emit(ctx, {
    table: [],
    columns: [{ name: 'title' }],
  })

  assert.strictEqual(out.length, 0)
})

test('table formatter is applied', () => {
  const out: string[] = []
  const ctx = createMockContext({ io: { out: (m) => out.push(m), err: () => {} } })

  const originalIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })

  try {
    emit(ctx, {
      table: [{ duration: 180000 }, { duration: 240000 }],
      columns: [
        {
          name: 'duration',
          formatter: (v) => {
            const ms = v as number
            const totalSeconds = Math.floor(ms / 1000)
            const minutes = Math.floor(totalSeconds / 60)
            const seconds = totalSeconds % 60
            return `${minutes}:${String(seconds).padStart(2, '0')}`
          },
        },
      ],
    })

    const output = out[0]
    assert.match(output, /3:00/)
    assert.match(output, /4:00/)
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
  }
})

test('table truncates with ellipsis when content exceeds width', () => {
  const out: string[] = []
  const ctx = createMockContext({ io: { out: (m) => out.push(m), err: () => {} } })

  const originalIsTTY = process.stdout.isTTY
  const originalColumns = process.stdout.columns
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdout, 'columns', { value: 30, configurable: true })

  try {
    emit(ctx, {
      table: [{ title: 'This is a very long song title that should be truncated' }],
      columns: [{ name: 'title', width: 50 }],
    })

    const output = out[0]
    const lines = output.split('\n')
    const dataLine = lines[2] // Skip header and separator
    assert.ok(dataLine.includes('…'))
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
  }
})

test('tab-separated mode replaces tabs and newlines with spaces', () => {
  const out: string[] = []
  const ctx = createMockContext({ io: { out: (m) => out.push(m), err: () => {} } })

  const originalIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })

  try {
    emit(ctx, {
      table: [{ title: 'Song\twith\ttabs', artist: 'Artist\nwith\nnewlines' }],
      columns: [
        { name: 'title' },
        { name: 'artist' },
      ],
    })

    const output = out[0]
    assert.match(output, /Song with tabs/)
    assert.match(output, /Artist with newlines/)
    assert.ok(!output.includes('\t\t'))
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
  }
})

test('boolean values are formatted as yes/no in table mode', () => {
  const out: string[] = []
  const ctx = createMockContext({ io: { out: (m) => out.push(m), err: () => {} } })

  const originalIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })

  try {
    emit(ctx, {
      table: [
        { name: 'Playlist 1', public: true },
        { name: 'Playlist 2', public: false },
      ],
      columns: [
        { name: 'name' },
        { name: 'public' },
      ],
    })

    const output = out[0]
    assert.match(output, /yes/)
    assert.match(output, /no/)
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
  }
})

test('null and undefined values are rendered as empty strings', () => {
  const out: string[] = []
  const ctx = createMockContext({ io: { out: (m) => out.push(m), err: () => {} } })

  const originalIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })

  try {
    emit(ctx, {
      table: [{ title: 'Song', album: null, artist: undefined }],
      columns: [
        { name: 'title' },
        { name: 'album' },
        { name: 'artist' },
      ],
    })

    const output = out[0]
    // Should have empty space for null/undefined values
    assert.ok(output.includes('Song'))
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
  }
})
