import { test } from 'node:test'
import * as assert from 'node:assert'
import { readRefsFromStream, progress, confirm } from '../../src/cli/input.js'
import { Readable } from 'node:stream'

test('readRefsFromStream reads newline-separated refs', async () => {
  const input = new Readable()
  input.push('spotify:playlist:abc123\n')
  input.push('spotify:playlist:def456\n')
  input.push(null)

  const refs = await readRefsFromStream(input)
  assert.deepStrictEqual(refs, ['spotify:playlist:abc123', 'spotify:playlist:def456'])
})

test('readRefsFromStream ignores blank lines', async () => {
  const input = new Readable()
  input.push('spotify:playlist:abc123\n')
  input.push('\n')
  input.push('  \n')
  input.push('spotify:playlist:def456\n')
  input.push(null)

  const refs = await readRefsFromStream(input)
  assert.deepStrictEqual(refs, ['spotify:playlist:abc123', 'spotify:playlist:def456'])
})

test('readRefsFromStream ignores comments starting with #', async () => {
  const input = new Readable()
  input.push('# This is a comment\n')
  input.push('spotify:playlist:abc123\n')
  input.push('# Another comment\n')
  input.push('spotify:playlist:def456\n')
  input.push('#spotify:playlist:ghi789\n')
  input.push(null)

  const refs = await readRefsFromStream(input)
  assert.deepStrictEqual(refs, ['spotify:playlist:abc123', 'spotify:playlist:def456'])
})

test('readRefsFromStream returns empty array for empty input', async () => {
  const input = new Readable()
  input.push(null)

  const refs = await readRefsFromStream(input)
  assert.deepStrictEqual(refs, [])
})

test('readRefsFromStream trims whitespace from refs', async () => {
  const input = new Readable()
  input.push('  spotify:playlist:abc123  \n')
  input.push('\tspotify:playlist:def456\t\n')
  input.push(null)

  const refs = await readRefsFromStream(input)
  assert.deepStrictEqual(refs, ['spotify:playlist:abc123', 'spotify:playlist:def456'])
})

test('progress writes to stderr when TTY', () => {
  const originalStderr = process.stderr
  const output: string[] = []

  // Create a mock with write method
  const writeMock = (msg: string) => {
    output.push(msg)
    return true
  }

  // Save original properties
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
  const originalWrite = Object.getOwnPropertyDescriptor(process.stderr, 'write')

  // Mock the properties
  Object.defineProperty(process.stderr, 'isTTY', {
    value: true,
    configurable: true,
  })
  Object.defineProperty(process.stderr, 'write', {
    value: writeMock,
    configurable: true,
  })

  try {
    progress('Processing playlist')
    assert.strictEqual(output.length, 1)
    assert.strictEqual(output[0], 'Processing playlist\n')
  } finally {
    // Restore original properties
    if (originalIsTTY) {
      Object.defineProperty(process.stderr, 'isTTY', originalIsTTY)
    } else {
      delete (process.stderr as any).isTTY
    }
    if (originalWrite) {
      Object.defineProperty(process.stderr, 'write', originalWrite)
    } else {
      delete (process.stderr as any).write
    }
  }
})

test('progress includes total count when provided', () => {
  const output: string[] = []

  // Create a mock with write method
  const writeMock = (msg: string) => {
    output.push(msg)
    return true
  }

  // Save original properties
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
  const originalWrite = Object.getOwnPropertyDescriptor(process.stderr, 'write')

  // Mock the properties
  Object.defineProperty(process.stderr, 'isTTY', {
    value: true,
    configurable: true,
  })
  Object.defineProperty(process.stderr, 'write', {
    value: writeMock,
    configurable: true,
  })

  try {
    progress('Processing', 42)
    assert.strictEqual(output.length, 1)
    assert.strictEqual(output[0], 'Processing [42]\n')
  } finally {
    // Restore original properties
    if (originalIsTTY) {
      Object.defineProperty(process.stderr, 'isTTY', originalIsTTY)
    } else {
      delete (process.stderr as any).isTTY
    }
    if (originalWrite) {
      Object.defineProperty(process.stderr, 'write', originalWrite)
    } else {
      delete (process.stderr as any).write
    }
  }
})

test('progress is no-op when stderr is not TTY', () => {
  const stderr = process.stderr
  const output: string[] = []

  const mockStderr = {
    isTTY: false,
    write: (msg: string) => {
      output.push(msg)
      return true
    },
  }

  Object.defineProperty(process, 'stderr', {
    value: mockStderr,
    configurable: true,
  })

  try {
    progress('Processing playlist')
    assert.strictEqual(output.length, 0)
  } finally {
    Object.defineProperty(process, 'stderr', { value: stderr, configurable: true })
  }
})

test('confirm returns true with --yes flag', async () => {
  const result = await confirm('Delete all playlists?', true)
  assert.strictEqual(result, true)
})

test('confirm throws UsageError without TTY and without --yes', async () => {
  const stdin = process.stdin

  const mockStdin = {
    isTTY: false,
  }

  Object.defineProperty(process, 'stdin', {
    value: mockStdin,
    configurable: true,
  })

  try {
    await assert.rejects(
      () => confirm('Delete all playlists?', false),
      (err: any) => {
        return (
          err.constructor.name === 'UsageError' &&
          err.message.includes('stdin is not a terminal')
        )
      }
    )
  } finally {
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  }
})
